//! The space lifecycle: creating one, renaming it, leaving it and deleting it.
//!
//! A space is the tenant boundary: everything else (channels, DMs, files, members) hangs off one.
//! Creating one is therefore the only endpoint in the messaging surface that needs no existing
//! membership, just a session. The creator becomes the space's `owner`.
//!
//! A new space is born with one public channel so it is usable immediately: a space with no
//! conversation is a dead end for the person who just created it.
//!
//! The two ways out are deliberately different operations. **Leaving** takes one membership away
//! and touches nothing else: the space carries on, and the person's messages stay where they were
//! written, because a conversation others took part in is not one member's to erase. **Deleting**
//! is the owner destroying the space itself, and it is immediate and total: rows go with the
//! cascade, stored objects are removed behind them, and nothing is kept for a grace period. A
//! product that sells control over one's own data does not get to hold on to data it was told to
//! destroy; what protects against a mistake here is the instance backup, not a hidden copy.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use sea_orm::ActiveValue::{NotSet, Set};
use sea_orm::IntoActiveModel;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter,
    TransactionTrait,
};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::auth::extract::AuthSession;
use crate::entities::{
    channel_members, channels, conversations, file_versions, files, messages, space_members,
    space_slugs, spaces,
};
use crate::state::AppState;

use super::dto::{
    CreateSpaceRequest, MemberRoleChangedDto, SetDefaultChannelRequest, SpaceDto, SpaceRefDto,
    SpaceRemovedDto, SpaceUpdatedDto, UpdateMemberRoleRequest, UpdateSpaceRequest,
};
use super::error::ApiError;
use super::slug::{slugify, MAX_HANDLE_LEN};
use crate::realtime::event::RealtimeEnvelope;

/// The channel every new space starts with. Its id, not this conventional handle, remains the
/// default when it is renamed.
const INITIAL_CHANNEL: &str = "general";

/// The `system_event` discriminator written into the channel when someone leaves the space. The
/// counterpart of the invitation path's arrival notice, and like it, the client turns it into a
/// sentence: the database never stores one.
const LEFT_EVENT: &str = "member_left";

/// The `system_event` written when someone is taken out of a space by an administrator. Distinct
/// from [`LEFT_EVENT`] because "X left the space" about someone who was shown the door is a small
/// lie, and the channel notice is the durable record the people who stayed will read.
const REMOVED_EVENT: &str = "member_removed";

/// Why a space stopped being someone's, as carried by `space.removed`.
const REASON_LEFT: &str = "left";
const REASON_DELETED: &str = "deleted";
const REASON_REMOVED: &str = "removed";

/// Announce a changed space to its members.
///
/// A space's name and mark are drawn by the rail, the mobile top bar, the switcher and the sidebar
/// header, all fed by a list loaded when the client signed in. Without this the change reaches
/// everyone else only on their next reload, which is how a new icon looks like it did not save.
///
/// Best-effort: a delivery problem must not fail the write that already succeeded.
///
/// `actor` is the member who made the change, needed only to authorise reading the roster: they are
/// in the audience too, so their own other tabs follow.
pub async fn broadcast_space_change(state: &AppState, space: &spaces::Model, actor: Uuid) {
    let Ok(audience) = super::authz::space_member_ids(&state.db, space.id, actor).await else {
        return;
    };
    let payload = SpaceUpdatedDto {
        id: space.id,
        name: space.name.clone(),
        slug: space.slug.clone(),
        icon_url: space
            .icon_key
            .as_deref()
            .map(|key| crate::files::icon_url(space.id, key)),
        default_channel_id: space.default_channel_id,
    };
    state
        .hub
        .publish(audience, RealtimeEnvelope::space_updated(&payload))
        .await;
}

/// `POST /api/v1/spaces`: create a space owned by the caller.
#[utoipa::path(
    post,
    path = "/api/v1/spaces",
    tag = "messaging",
    request_body = CreateSpaceRequest,
    responses(
        (status = 201, description = "Space created", body = SpaceDto),
        (status = 400, description = "The name is empty or has no usable characters"),
        (status = 401, description = "No session")
    )
)]
pub async fn create_space(
    State(state): State<AppState>,
    session: AuthSession,
    Json(body): Json<CreateSpaceRequest>,
) -> Result<(StatusCode, Json<SpaceDto>), ApiError> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > MAX_HANDLE_LEN {
        return Err(ApiError::BadRequest("a space needs a name"));
    }
    let base = slugify(name);
    if base.is_empty() {
        return Err(ApiError::BadRequest("this name has no usable characters"));
    }

    let txn = state.db.begin().await?;
    let (space_id, slug) = create_owned_space(&txn, name, session.user_id).await?;
    txn.commit().await?;
    let default_channel_id = spaces::Entity::find_by_id(space_id)
        .one(&state.db)
        .await?
        .and_then(|space| space.default_channel_id);

    Ok((
        StatusCode::CREATED,
        Json(SpaceDto {
            id: space_id,
            name: name.to_owned(),
            slug,
            role: "owner".to_owned(),
            members: 1,
            // A space one second old, holding one empty channel: both counters are zero by
            // construction, not by omission.
            unread: 0,
            mentions: 0,
            // Brand new, so nothing has been uploaded for it yet.
            icon_url: None,
            default_channel_id,
            notify_level: "default".to_owned(),
        }),
    ))
}

/// Create a space owned by `owner`, born with one public channel, and return its id and slug.
///
/// Shared by the endpoint above and the `bootstrap` subcommand, so "a space is never an empty
/// shell" holds wherever a space comes from rather than only where someone remembered it.
pub(crate) async fn create_owned_space<C: ConnectionTrait>(
    txn: &C,
    name: &str,
    owner: Uuid,
) -> Result<(Uuid, String), ApiError> {
    let space_id = Uuid::new_v4();
    let channel_id = Uuid::new_v4();
    let now = OffsetDateTime::now_utc();

    // Slugs are unique across the workspace, so two spaces called "Atelier" get `atelier` and
    // `atelier-2`. Resolved inside the caller's transaction, and the unique index stays the real
    // guard.
    let slug = unique_slug(txn, &slugify(name)).await?;
    spaces::ActiveModel {
        id: Set(space_id),
        name: Set(name.to_owned()),
        slug: Set(slug.clone()),
        created_by: Set(Some(owner)),
        icon_key: Set(None),
        default_channel_id: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(txn)
    .await?;
    // The address is recorded after the space exists, not before: `space_slugs.space_id` points at
    // `spaces.id` and the constraint is checked immediately, so the other order made every single
    // space creation fail on a foreign key. It had gone unnoticed because the only two spaces on the
    // instance predate the address history.
    remember_slug(txn, space_id, &slug).await?;
    space_members::ActiveModel {
        space_id: Set(space_id),
        user_id: Set(owner),
        role: Set("owner".to_owned()),
        invited_by: Set(None),
        joined_at: Set(now),
    }
    .insert(txn)
    .await?;

    // The starting channel. A channel row is the detail table of a conversation, so the
    // conversation comes first (the foreign key points at it).
    conversations::ActiveModel {
        id: Set(channel_id),
        space_id: Set(space_id),
        kind: Set("channel".to_owned()),
        created_at: Set(now),
    }
    .insert(txn)
    .await?;
    channels::ActiveModel {
        id: Set(channel_id),
        space_id: Set(space_id),
        name: Set(INITIAL_CHANNEL.to_owned()),
        channel_type: Set("public".to_owned()),
        topic: Set(None),
        created_by: Set(Some(owner)),
        archived_at: Set(None),
        imported_source: Set(None),
        external_ref: Set(None),
        position: Set(None),
        created_at: Set(now),
    }
    .insert(txn)
    .await?;
    // And its first calendar, named after it.
    crate::calendar::authz::create_space_default(txn, space_id, Some(owner))
        .await
        .map_err(|_| ApiError::Internal)?;
    let mut space = spaces::Entity::find_by_id(space_id)
        .one(txn)
        .await?
        .ok_or(ApiError::Internal)?
        .into_active_model();
    space.default_channel_id = Set(Some(channel_id));
    space.updated_at = Set(now);
    space.update(txn).await?;
    channel_members::ActiveModel {
        channel_id: Set(channel_id),
        user_id: Set(owner),
        role: Set("owner".to_owned()),
        notification_level: Set("default".to_owned()),
        muted: Set(false),
        favorite: Set(false),
        joined_at: Set(now),
    }
    .insert(txn)
    .await?;

    Ok((space_id, slug))
}

/// The first free slug in the `base`, `base-2`, `base-3` ... series.
pub(crate) async fn unique_slug<C: ConnectionTrait>(
    db: &C,
    base: &str,
) -> Result<String, ApiError> {
    for suffix in 1..=50u32 {
        let candidate = if suffix == 1 {
            base.to_owned()
        } else {
            format!("{base}-{suffix}")
        };
        // Against the history, not against the spaces in use: a slug a renamed space used to answer
        // to still resolves to it, so handing it to a new space would hijack every link shared for
        // the old one.
        let taken = space_slugs::Entity::find_by_id(candidate.clone())
            .one(db)
            .await?
            .is_some();
        if !taken {
            return Ok(candidate);
        }
    }
    Err(ApiError::BadRequest(
        "too many spaces share this name; choose another",
    ))
}

/// Record a slug as one this space answers to, now and for good.
///
/// Never deleted, including when the space moves off it: the whole point is that an address already
/// shared keeps arriving.
pub(crate) async fn remember_slug<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
    slug: &str,
) -> Result<(), ApiError> {
    space_slugs::ActiveModel {
        slug: Set(slug.to_owned()),
        space_id: Set(space_id),
        created_at: NotSet,
    }
    .insert(db)
    .await?;
    Ok(())
}

/// `PATCH /api/v1/spaces/{space_id}`: rename a space. Owner only.
///
/// The slug follows the name, and the one it leaves behind keeps working: every slug a space has
/// ever answered to is kept, and resolves to it forever. That is what lets the address stay honest
/// (it reads like the space is called) without breaking the bookmarks and links people already hold.
/// A slug is only minted when it is free in that whole history, so a retired address can never be
/// handed to another space.
#[utoipa::path(
    patch,
    path = "/api/v1/spaces/{space_id}",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = UpdateSpaceRequest,
    responses(
        (status = 200, description = "The space's new shared identity", body = SpaceUpdatedDto),
        (status = 400, description = "Empty or over-long name"),
        (status = 403, description = "Not the owner of the space")
    )
)]
pub async fn update_space(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<UpdateSpaceRequest>,
) -> Result<Json<SpaceUpdatedDto>, ApiError> {
    // The space's name is its identity, and an identity belongs to whoever holds the space. An
    // administrator runs it; renaming it out from under its owner is not running it.
    super::authz::ensure_space_owner(&state.db, space_id, session.user_id).await?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > MAX_HANDLE_LEN {
        return Err(ApiError::BadRequest("a space needs a name"));
    }

    let space = spaces::Entity::find_by_id(space_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    // A rename that does not change the derived handle (capitalisation, punctuation) leaves the slug
    // alone: there is nothing to move, and minting `atelier-2` for it would be absurd.
    let txn = state.db.begin().await?;
    let wanted = slugify(name);
    let slug = if wanted.is_empty() || wanted == space.slug {
        space.slug.clone()
    } else {
        let fresh = unique_slug(&txn, &wanted).await?;
        remember_slug(&txn, space_id, &fresh).await?;
        fresh
    };
    let calendar = crate::calendar::authz::follow_space_name(&txn, space_id, &space.name, name)
        .await
        .map_err(|_| ApiError::Internal)?;
    let mut active = space.into_active_model();
    active.name = Set(name.to_owned());
    active.slug = Set(slug);
    active.updated_at = Set(OffsetDateTime::now_utc());
    let updated = active.update(&txn).await?;
    txn.commit().await?;

    broadcast_space_change(&state, &updated, session.user_id).await;
    if let Some(calendar) = calendar {
        // Best effort: the rename stands even if nobody hears about the calendar's new name now.
        let _ = crate::calendar::calendars::announce(&state, &calendar).await;
    }
    Ok(Json(SpaceUpdatedDto {
        id: updated.id,
        name: updated.name.clone(),
        slug: updated.slug.clone(),
        icon_url: updated
            .icon_key
            .as_deref()
            .map(|key| crate::files::icon_url(updated.id, key)),
        default_channel_id: updated.default_channel_id,
    }))
}

/// `PUT /api/v1/spaces/{space_id}/default-channel`: choose where newly invited people arrive.
#[utoipa::path(
    put,
    path = "/api/v1/spaces/{space_id}/default-channel",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    request_body = SetDefaultChannelRequest,
    responses(
        (status = 200, description = "The space's updated shared settings", body = SpaceUpdatedDto),
        (status = 400, description = "The channel is not an eligible default channel"),
        (status = 403, description = "Not a space administrator")
    )
)]
pub async fn set_default_channel(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
    Json(body): Json<SetDefaultChannelRequest>,
) -> Result<Json<SpaceUpdatedDto>, ApiError> {
    super::authz::ensure_space_admin(&state.db, space_id, session.user_id).await?;
    let space = spaces::Entity::find_by_id(space_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    ensure_default_channel(&state.db, &space, body.channel_id).await?;

    let mut active = space.into_active_model();
    active.default_channel_id = Set(Some(body.channel_id));
    active.updated_at = Set(OffsetDateTime::now_utc());
    let updated = active.update(&state.db).await?;
    broadcast_space_change(&state, &updated, session.user_id).await;
    Ok(Json(space_updated_dto(&updated)))
}

fn space_updated_dto(space: &spaces::Model) -> SpaceUpdatedDto {
    SpaceUpdatedDto {
        id: space.id,
        name: space.name.clone(),
        slug: space.slug.clone(),
        icon_url: space
            .icon_key
            .as_deref()
            .map(|key| crate::files::icon_url(space.id, key)),
        default_channel_id: space.default_channel_id,
    }
}

/// Check that the selected channel is a stable arrival point for every invitation role.
async fn ensure_default_channel<C: ConnectionTrait>(
    db: &C,
    space: &spaces::Model,
    channel_id: Uuid,
) -> Result<(), ApiError> {
    let channel = channels::Entity::find_by_id(channel_id)
        .one(db)
        .await?
        .ok_or(ApiError::BadRequest(
            "the channel does not belong to this space",
        ))?;
    if channel.space_id != space.id
        || channel.channel_type != "public"
        || channel.archived_at.is_some()
        || super::authz::channel_allowed_roles(db, channel_id)
            .await?
            .is_some()
    {
        return Err(ApiError::BadRequest(
            "a default channel must be public, active and open to every role",
        ));
    }
    Ok(())
}

/// The configured arrival channel, checked again before it is used for an invitation.
pub(crate) async fn default_channel<C: ConnectionTrait>(
    db: &C,
    space_id: Uuid,
) -> Result<Uuid, ApiError> {
    let space = spaces::Entity::find_by_id(space_id)
        .one(db)
        .await?
        .ok_or(ApiError::NotFound)?;
    let channel_id = space
        .default_channel_id
        .ok_or(ApiError::Conflict("this space has no default channel"))?;
    ensure_default_channel(db, &space, channel_id).await?;
    Ok(channel_id)
}

/// `GET /api/v1/spaces/by-slug/{slug}`: which space an address names, current or retired.
///
/// The client addresses a space by slug and holds its own list, so it only needs this when the slug
/// in an address matches nothing it knows: a link written before a rename. The answer carries the
/// current slug so the caller can correct the address it was opened with.
///
/// A `404` covers both "no such slug" and "not a space you are in", so this cannot be used to
/// discover which spaces exist on an instance.
#[utoipa::path(
    get,
    path = "/api/v1/spaces/by-slug/{slug}",
    tag = "messaging",
    params(("slug" = String, Path, description = "A slug the space answers to, current or retired")),
    responses(
        (status = 200, description = "The space this slug leads to", body = SpaceRefDto),
        (status = 404, description = "Unknown slug, or not a space the caller belongs to")
    )
)]
pub async fn resolve_space_slug(
    State(state): State<AppState>,
    session: AuthSession,
    Path(slug): Path<String>,
) -> Result<Json<SpaceRefDto>, ApiError> {
    let alias = space_slugs::Entity::find_by_id(slug.to_lowercase())
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    if !super::authz::is_space_member(&state.db, alias.space_id, session.user_id).await? {
        return Err(ApiError::NotFound);
    }
    let space = spaces::Entity::find_by_id(alias.space_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(SpaceRefDto {
        id: space.id,
        slug: space.slug,
    }))
}

/// `PATCH /api/v1/spaces/{space_id}/members/{user_id}`: change what a member may do in a space.
///
/// **One rule, applied twice.** You may only act on someone ranked strictly below you, and you may
/// only hand out a rank strictly below your own. Ranks are `guest` < `member` < `admin` < `owner`.
/// Everything follows from it: nobody can change their own role, an admin can make members and
/// guests but not other admins, an admin cannot demote another admin, and nobody outranks the owner.
///
/// **The one exception is the transfer.** An owner may set someone else to `owner`, and becomes an
/// `admin` in the same write. A space therefore has exactly one owner at any moment, which is what
/// the refusal in [`leave_space`] points at: an owner who wants out hands the space over first. The
/// demotion is not a courtesy the code invents, it is the transfer: two people holding the same
/// space would make "the last owner" a question rather than a fact.
///
/// Invitations cannot grant `owner` either (the schema constrains them to `admin`, `member`,
/// `guest`), so this endpoint is the only door ownership ever moves through after a space is
/// created.
#[utoipa::path(
    patch,
    path = "/api/v1/spaces/{space_id}/members/{user_id}",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("user_id" = Uuid, Path, description = "The member whose role is changing")
    ),
    request_body = UpdateMemberRoleRequest,
    responses(
        (status = 200, description = "Every membership this changed", body = Vec<MemberRoleChangedDto>),
        (status = 400, description = "Not a role this instance knows"),
        (status = 403, description = "Not allowed to give this role to this member"),
        (status = 404, description = "Not a member of this space")
    )
)]
pub async fn update_member_role(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<UpdateMemberRoleRequest>,
) -> Result<Json<Vec<MemberRoleChangedDto>>, ApiError> {
    let wanted = body.role.trim().to_lowercase();
    if !super::authz::is_space_role(&wanted) {
        return Err(ApiError::BadRequest("this instance has no such role"));
    }

    let actor = space_members::Entity::find_by_id((space_id, session.user_id))
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let actor_rank = super::authz::role_rank(&actor.role);
    // Acting on one's own membership is caught by the rank rule below (nobody ranks below
    // themselves), but it is worth refusing by name: it is the one case a client could reach by
    // accident rather than by trying.
    if user_id == session.user_id || actor_rank < super::authz::role_rank("admin") {
        return Err(ApiError::Forbidden);
    }

    let target = space_members::Entity::find_by_id((space_id, user_id))
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    if target.role == wanted {
        // Nothing to write, and nothing to announce. Answering `200` with an empty list keeps the
        // call idempotent instead of making a second press an error.
        return Ok(Json(Vec::new()));
    }

    let transfer = wanted == "owner";
    let allowed = super::authz::role_rank(&target.role) < actor_rank
        && if transfer {
            actor.role == "owner"
        } else {
            super::authz::role_rank(&wanted) < actor_rank
        };
    if !allowed {
        return Err(ApiError::Forbidden);
    }

    let txn = state.db.begin().await?;
    let mut promoted = target.into_active_model();
    promoted.role = Set(wanted.clone());
    promoted.update(&txn).await?;
    let mut changes = vec![MemberRoleChangedDto {
        space_id,
        user_id,
        role: wanted,
    }];
    if transfer {
        let mut stepping_down = actor.into_active_model();
        stepping_down.role = Set("admin".to_owned());
        stepping_down.update(&txn).await?;
        changes.push(MemberRoleChangedDto {
            space_id,
            user_id: session.user_id,
            role: "admin".to_owned(),
        });
    }
    txn.commit().await?;

    // Told to the whole space, not only to the two people involved: a role decides what the member
    // list shows, who may be invited, and which controls each person is offered. The actor is in the
    // audience too, so their own other tabs follow a transfer they made here.
    let audience = super::authz::space_member_ids(&state.db, space_id, session.user_id).await?;
    for change in &changes {
        state
            .hub
            .publish(
                audience.clone(),
                RealtimeEnvelope::member_role_changed(change),
            )
            .await;
    }
    Ok(Json(changes))
}

/// `DELETE /api/v1/spaces/{space_id}/membership`: leave a space.
///
/// Only the caller's own membership goes, here and in the channels of that space. What they wrote
/// stays: a channel is a shared record, and taking one member's messages out of it would rewrite
/// everyone else's history. Coming back needs a new invitation, which is what makes this worth a
/// confirmation on the way out rather than an undo afterwards.
///
/// **The last owner is refused.** An owner may walk out of a space that still has another owner;
/// the last one cannot, because the space would be left with nobody able to administer it, invite
/// into it or delete it. They are told to hand ownership over or to delete the space, which is a
/// `409`: the request is not malformed, the space is simply not in a state that allows it.
#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/membership",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 204, description = "The caller is no longer a member"),
        (status = 403, description = "Not a member of the space"),
        (status = 409, description = "The caller is the space's last owner")
    )
)]
pub async fn leave_space(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let membership = space_members::Entity::find_by_id((space_id, session.user_id))
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;

    if membership.role == "owner" {
        let owners = space_members::Entity::find()
            .filter(space_members::Column::SpaceId.eq(space_id))
            .filter(space_members::Column::Role.eq("owner"))
            .count(&state.db)
            .await?;
        if owners <= 1 {
            return Err(ApiError::Conflict(
                "you are this space's last owner: hand the space over to someone else, or delete it",
            ));
        }
    }

    // Read the roster while the caller is still on it: it is what the departure has to be announced
    // to, and one second later the query no longer authorises them to ask for it.
    let audience = super::authz::space_member_ids(&state.db, space_id, session.user_id).await?;

    let txn = state.db.begin().await?;
    let notice = withdraw_membership(&txn, space_id, session.user_id, LEFT_EVENT).await?;
    txn.commit().await?;

    announce_departure(&state, space_id, session.user_id, audience, REASON_LEFT).await;
    if let Some(notice) = notice {
        publish_notice(&state, session.user_id, notice).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Take one membership out of a space, and write the notice that says so.
///
/// Shared by leaving and by being removed, because the two differ in who decided and in nothing
/// else. The channel memberships inside the space go with the space membership: leaving them would
/// leave rows granting access to private channels of a space the person is no longer in, the kind of
/// leftover that only surfaces the day somebody is invited back.
///
/// The notice is written where the arrival notice is, the space's default channel. A push
/// scrolls away, the history stays, and a member list that silently loses a row leaves the people
/// who stayed with no idea when it happened. Like the arrival, the row holds the *event* and never a
/// sentence: the words belong to whoever is reading.
async fn withdraw_membership<C: ConnectionTrait>(
    txn: &C,
    space_id: Uuid,
    user_id: Uuid,
    event: &str,
) -> Result<Option<messages::Model>, ApiError> {
    let channel_ids: Vec<Uuid> = channels::Entity::find()
        .filter(channels::Column::SpaceId.eq(space_id))
        .all(txn)
        .await?
        .into_iter()
        .map(|channel| channel.id)
        .collect();
    if !channel_ids.is_empty() {
        channel_members::Entity::delete_many()
            .filter(channel_members::Column::UserId.eq(user_id))
            .filter(channel_members::Column::ChannelId.is_in(channel_ids))
            .exec(txn)
            .await?;
    }
    space_members::Entity::delete_by_id((space_id, user_id))
        .exec(txn)
        .await?;

    let channel = default_channel(txn, space_id).await?;
    Ok(Some(
        messages::ActiveModel {
            id: Set(Uuid::new_v4()),
            conversation_id: Set(channel),
            // The person the notice is about, so the client can name them without a second lookup.
            // For a removal that is still the person who left the space, not the one who decided it:
            // the roster lost a name, and that name is the subject of the sentence.
            author_id: Set(Some(user_id)),
            kind: Set("system".to_owned()),
            system_event: Set(Some(event.to_owned())),
            created_at: Set(OffsetDateTime::now_utc()),
            ..Default::default()
        }
        .insert(txn)
        .await?,
    ))
}

/// Send a freshly written system message to the channel it belongs to. It travels as an ordinary
/// `message.created`, so every client that renders a message renders this one with no new case.
async fn publish_notice(
    state: &AppState,
    actor: Uuid,
    notice: messages::Model,
) -> Result<(), ApiError> {
    let conversation_id = notice.conversation_id;
    let audience: Vec<Uuid> = channel_members::Entity::find()
        .filter(channel_members::Column::ChannelId.eq(conversation_id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|member| member.user_id)
        .collect();
    if audience.is_empty() {
        return Ok(());
    }
    if let Some(dto) = super::messages::hydrate_messages(&state.db, actor, vec![notice])
        .await?
        .pop()
    {
        state
            .hub
            .publish(
                audience,
                RealtimeEnvelope::message_created(conversation_id, dto),
            )
            .await;
    }
    Ok(())
}

/// `DELETE /api/v1/spaces/{space_id}/members/{user_id}`: take someone out of a space.
///
/// The administrator's counterpart of [`leave_space`], and the same rank rule as a role change: you
/// may only act on someone ranked strictly below you. An owner can remove an admin, an admin cannot;
/// nobody can remove the owner; and nobody removes themselves through here, which is what
/// [`leave_space`] is for and what makes the difference between walking out and being shown the
/// door legible in the history afterwards.
///
/// What they wrote stays, exactly as when they leave: a conversation is not one member's to erase,
/// and it is not an administrator's to erase on their behalf either. Coming back needs a new
/// invitation.
#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}/members/{user_id}",
    tag = "messaging",
    params(
        ("space_id" = Uuid, Path, description = "Space id"),
        ("user_id" = Uuid, Path, description = "The member being removed")
    ),
    responses(
        (status = 204, description = "They are no longer a member"),
        (status = 403, description = "Not allowed to remove this member"),
        (status = 404, description = "Not a member of this space")
    )
)]
pub async fn remove_member(
    State(state): State<AppState>,
    session: AuthSession,
    Path((space_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let actor = space_members::Entity::find_by_id((space_id, session.user_id))
        .one(&state.db)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let actor_rank = super::authz::role_rank(&actor.role);
    if user_id == session.user_id || actor_rank < super::authz::role_rank("admin") {
        return Err(ApiError::Forbidden);
    }
    let target = space_members::Entity::find_by_id((space_id, user_id))
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    if super::authz::role_rank(&target.role) >= actor_rank {
        return Err(ApiError::Forbidden);
    }

    // Read while they are still on the roster: it is who the departure is announced to, and the
    // person leaving has to be in it to be told the space is no longer theirs.
    let audience = super::authz::space_member_ids(&state.db, space_id, session.user_id).await?;

    let txn = state.db.begin().await?;
    let notice = withdraw_membership(&txn, space_id, user_id, REMOVED_EVENT).await?;
    txn.commit().await?;

    announce_departure(&state, space_id, user_id, audience, REASON_REMOVED).await;
    if let Some(notice) = notice {
        publish_notice(&state, session.user_id, notice).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/spaces/{space_id}`: delete a space and everything in it. Owner only.
///
/// Not open to an admin: an admin manages who is in a space and what it looks like, and destroying
/// it is a different kind of act. Everything in the schema hangs off the space with a cascading
/// foreign key, so one row deletion takes the channels, messages, memberships, invitations, file
/// records and address history with it. The stored objects are not in the database, so they are
/// collected first and removed behind the transaction: without that step, deleting a space would
/// leave its files sitting in the object store while the interface reported them gone.
#[utoipa::path(
    delete,
    path = "/api/v1/spaces/{space_id}",
    tag = "messaging",
    params(("space_id" = Uuid, Path, description = "Space id")),
    responses(
        (status = 204, description = "The space and everything in it are gone"),
        (status = 403, description = "Not the owner of the space")
    )
)]
pub async fn delete_space(
    State(state): State<AppState>,
    session: AuthSession,
    Path(space_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    match space_members::Entity::find_by_id((space_id, session.user_id))
        .one(&state.db)
        .await?
    {
        Some(membership) if membership.role == "owner" => {}
        _ => return Err(ApiError::Forbidden),
    }
    let space = spaces::Entity::find_by_id(space_id)
        .one(&state.db)
        .await?
        .ok_or(ApiError::NotFound)?;

    // Both read before the cascade removes the rows that name them.
    let audience = super::authz::space_member_ids(&state.db, space_id, session.user_id).await?;
    let mut keys = stored_object_keys(&state, space_id).await?;
    keys.extend(space.icon_key);

    spaces::Entity::delete_by_id(space_id)
        .exec(&state.db)
        .await?;

    forget_objects(&state, keys).await;
    let removed = SpaceRemovedDto {
        space_id,
        reason: REASON_DELETED.to_owned(),
    };
    state
        .hub
        .publish(audience, RealtimeEnvelope::space_removed(&removed))
        .await;
    crate::realtime::presence::refresh_and_broadcast(&state, session.user_id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// Tell the space that someone walked out of it, and tell them that it is no longer theirs.
///
/// Two events because they say two different things to two different audiences: the people staying
/// need the roster corrected, the person leaving needs the space off their rail (in every tab they
/// have open, not only the one they clicked in). Best-effort, like every other push: the membership
/// is already gone, and a delivery problem must not turn that into a failed request.
async fn announce_departure(
    state: &AppState,
    space_id: Uuid,
    user_id: Uuid,
    audience: Vec<Uuid>,
    reason: &str,
) {
    let staying: Vec<Uuid> = audience.into_iter().filter(|id| *id != user_id).collect();
    if !staying.is_empty() {
        let left = super::dto::MemberLeftDto { space_id, user_id };
        state
            .hub
            .publish(staying, RealtimeEnvelope::member_left(&left))
            .await;
    }
    let removed = SpaceRemovedDto {
        space_id,
        reason: reason.to_owned(),
    };
    state
        .hub
        .publish(vec![user_id], RealtimeEnvelope::space_removed(&removed))
        .await;
    // The set of people this person shares a space with just shrank, and the presence fan-out
    // freezes its audience when a socket opens. Same call the invitation path makes on the way in.
    crate::realtime::presence::refresh_and_broadcast(state, user_id).await;
}

/// Every object key a space's files occupy: the bytes of each version, and the thumbnails derived
/// from the image ones. Soft-deleted files are included on purpose: their rows are about to go for
/// good, so this is the last moment their bytes can be named.
async fn stored_object_keys(state: &AppState, space_id: Uuid) -> Result<Vec<String>, ApiError> {
    let file_ids: Vec<Uuid> = files::Entity::find()
        .filter(files::Column::SpaceId.eq(space_id))
        .all(&state.db)
        .await?
        .into_iter()
        .map(|file| file.id)
        .collect();
    if file_ids.is_empty() {
        return Ok(Vec::new());
    }
    let versions = file_versions::Entity::find()
        .filter(file_versions::Column::FileId.is_in(file_ids))
        .all(&state.db)
        .await?;
    let mut keys = Vec::with_capacity(versions.len());
    for version in versions {
        keys.extend(
            version
                .storage_key
                .iter()
                .map(|key| crate::files::convert::pdf_key(key)),
        );
        keys.extend(version.storage_key);
        keys.extend(version.thumbnail_key);
    }
    Ok(keys)
}

/// Remove objects whose records are gone. A failure leaks one object and is logged rather than
/// raised: the deletion it belongs to has already been committed, and there is nothing left to
/// undo it with.
async fn forget_objects(state: &AppState, keys: Vec<String>) {
    let Some(storage) = state.storage.as_ref() else {
        return;
    };
    for key in keys {
        if let Err(error) = storage.delete(&key).await {
            tracing::warn!(%error, "could not delete an object of a deleted space");
        }
    }
}
