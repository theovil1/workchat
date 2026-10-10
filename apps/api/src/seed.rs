//! Development seed data.
//!
//! `ruchoir-api seed` populates a realistic dev workspace so later messaging, files and UI work has
//! representative data to build against. It is **dev-only**: the command refuses to run
//! unless `RUCHOIR_ENV=dev` (or `--force` is passed), so it can never touch a production database.
//!
//! It is idempotent at the workspace level: the six accounts are upserted by email (so they line up
//! with the Nextcloud import fixture), and if the demo space already exists the seed
//! stops early rather than duplicating rows. Running it twice leaves the same final state.
//!
//! Timestamps are left unset on insert so PostgreSQL fills its `now()` defaults; only natural keys
//! and non-default columns are written.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, DatabaseTransaction, DbErr, EntityTrait,
    IntoActiveModel, QueryFilter, Set, TransactionTrait,
};
use uuid::Uuid;

use crate::auth;
use crate::config::Config;
use crate::entities::{
    channel_members, channel_pins, channels, conversations, dm_conversations, dm_participants,
    file_shares, file_versions, files, message_attachments, message_link_previews,
    message_mentions, message_reactions, messages, notifications, read_cursors, space_members,
    spaces, user_preferences, user_saved_messages, users,
};

/// Shared password for every seeded account (matches the Nextcloud import fixture).
const SEED_PASSWORD: &str = "Passw0rd!seed";
/// Natural key of the demo space; its presence marks the database as already seeded.
/// The main demo space. The slug is what `slugify` derives from the name, exactly as it would be for
/// a space created through the API: a seeded space must not be addressable differently from a real
/// one. A unit test below keeps the pair from drifting.
const ATELIER_NAME: &str = "Atelier Nantes";
const ATELIER_SLUG: &str = "atelier-nantes";
/// The second demo space, which exists so the workspace rail has something to say.
const STUDIO_NAME: &str = "Studio Rennes";
const STUDIO_SLUG: &str = "studio-rennes";

/// Entry point for the `seed` subcommand.
pub async fn run(
    db: &DatabaseConnection,
    config: &Config,
) -> Result<(), Box<dyn std::error::Error>> {
    guard_dev_environment()?;

    let txn = db.begin().await?;

    // Accounts first (upserted by email so re-runs and existing dev accounts both work).
    let admin = upsert_user(&txn, config, "admin@atelier.test", "Camille Roussel").await?;
    // The demo administrator carries the instance-admin flag, so the account-recovery screen is
    // reachable in development without running `bootstrap` against the dev database.
    mark_instance_admin(&txn, admin).await?;
    let alice = upsert_user(&txn, config, "alice@atelier.test", "Alice Fournier").await?;
    let bob = upsert_user(&txn, config, "bob@atelier.test", "Yanis Berthier").await?;
    let carol = upsert_user(&txn, config, "carol@atelier.test", "Carol Nguyen").await?;
    let david = upsert_user(&txn, config, "david@atelier.test", "David Morel").await?;
    let emma = upsert_user(&txn, config, "emma@atelier.test", "Emma Leroy").await?;
    let users = SeedUsers {
        admin,
        alice,
        bob,
        carol,
        david,
        emma,
    };

    // Each space is guarded by its own slug rather than one global "already seeded" flag, so adding
    // a space to this file fills it into a database seeded before it existed instead of being
    // skipped. Re-running stays safe and additive.
    if !space_seeded(&txn, ATELIER_NAME, ATELIER_SLUG).await? {
        seed_atelier(&txn, &users).await?;
    }
    if !space_seeded(&txn, STUDIO_NAME, STUDIO_SLUG).await? {
        seed_studio(&txn, &users).await?;
    }

    txn.commit().await?;
    tracing::info!("seed: demo workspace ensured (2 spaces, 6 accounts, an import bot)");
    Ok(())
}

/// The six seeded accounts, passed around as one value so the space builders keep short signatures.
struct SeedUsers {
    admin: Uuid,
    alice: Uuid,
    bob: Uuid,
    carol: Uuid,
    david: Uuid,
    emma: Uuid,
}

impl SeedUsers {
    /// Everyone, owner first: the order membership roles are handed out in.
    fn all(&self) -> [Uuid; 6] {
        [
            self.admin, self.alice, self.bob, self.carol, self.david, self.emma,
        ]
    }
}

/// Whether this demo space is already seeded, repairing its slug on the way if it is stale.
///
/// Keyed on the name rather than the slug, because the slug is derived: changing how it is derived
/// must not make the seed believe the space is missing and create a second one. When an existing
/// space carries an older slug, it is rewritten to the canonical one, which is the seed's job since
/// it owns these rows.
async fn space_seeded(txn: &DatabaseTransaction, name: &str, slug: &str) -> Result<bool, DbErr> {
    let Some(existing) = spaces::Entity::find()
        .filter(spaces::Column::Name.eq(name))
        .one(txn)
        .await?
    else {
        return Ok(false);
    };
    if existing.slug != slug {
        tracing::info!(from = %existing.slug, to = %slug, "seed: updating a demo space slug");
        let mut active = existing.into_active_model();
        active.slug = Set(slug.to_owned());
        active.update(txn).await?;
    }
    Ok(true)
}

/// The main demo space: everyone, six channels, threads, reactions, files, a DM and an import bot.
async fn seed_atelier(txn: &DatabaseTransaction, users: &SeedUsers) -> Result<(), DbErr> {
    // Space and membership (admin owns it, everyone else is a member).
    let space_id = Uuid::new_v4();
    spaces::ActiveModel {
        id: Set(space_id),
        name: Set(ATELIER_NAME.to_owned()),
        slug: Set(ATELIER_SLUG.to_owned()),
        created_by: Set(Some(users.admin)),
        ..Default::default()
    }
    .insert(txn)
    .await?;

    for (i, member) in users.all().iter().enumerate() {
        space_members::ActiveModel {
            space_id: Set(space_id),
            user_id: Set(*member),
            role: Set(if i == 0 { "owner" } else { "member" }.to_owned()),
            invited_by: Set(if i == 0 { None } else { Some(users.admin) }),
            ..Default::default()
        }
        .insert(txn)
        .await?;
    }

    // Flesh out the owner's profile so the profile card has representative data.
    users::ActiveModel {
        id: Set(users.admin),
        title: Set(Some("Gerante de l'atelier".to_owned())),
        pronouns: Set(Some("elle".to_owned())),
        timezone: Set(Some("Europe/Paris".to_owned())),
        bio: Set(Some("Responsable de l'atelier et des annonces.".to_owned())),
        ..Default::default()
    }
    .update(txn)
    .await?;

    // Representative client preferences for the owner (theme/font/text size + JSON blobs).
    user_preferences::ActiveModel {
        user_id: Set(users.admin),
        theme: Set(Some("system".to_owned())),
        font: Set(Some("plex-sans".to_owned())),
        text_size: Set(Some("comfortable".to_owned())),
        emoji_pack: Set(Some("fluent".to_owned())),
        emoji_animated: Set(Some(true)),
        notifications: Set(Some(
            "{\"enabled\":true,\"sound\":true,\"quietHours\":false}".to_owned(),
        )),
        ui_state: Set(Some("{\"welcome\":{\"dismissed\":false}}".to_owned())),
        ..Default::default()
    }
    .insert(txn)
    .await?;

    // The import assistant: a bot account (no password), mirroring the mocked "Assistant d'import".
    let import_bot = create_bot(txn, "import-bot@atelier.test", "Assistant d'import").await?;
    space_members::ActiveModel {
        space_id: Set(space_id),
        user_id: Set(import_bot),
        role: Set("member".to_owned()),
        invited_by: Set(Some(users.admin)),
        ..Default::default()
    }
    .insert(txn)
    .await?;

    // Channels, mirroring the UI mock fixtures (general, private comptabilite, ...).
    let general = create_channel(
        txn,
        space_id,
        users.admin,
        "general",
        "public",
        Some("Annonces et vie de l'atelier"),
        None,
    )
    .await?;
    let compta = create_channel(
        txn,
        space_id,
        users.admin,
        "comptabilite-2026",
        "private",
        Some("Suivi des ecritures et rapprochements"),
        Some("slack"),
    )
    .await?;
    let bois = create_channel(
        txn,
        space_id,
        users.admin,
        "atelier-bois",
        "public",
        Some("Coordination de l'atelier bois"),
        None,
    )
    .await?;
    let chantier = create_channel(
        txn,
        space_id,
        users.admin,
        "chantier-reze",
        "public",
        Some("Chantier de Reze, suivi et logistique"),
        Some("mattermost"),
    )
    .await?;
    let veille = create_channel(
        txn,
        space_id,
        users.admin,
        "veille-marche",
        "public",
        Some("Appels d'offres et veille concurrentielle"),
        None,
    )
    .await?;
    let archives = create_channel(
        txn,
        space_id,
        users.admin,
        "archives-2025",
        "archived",
        Some("Canal archive, lecture seule"),
        None,
    )
    .await?;
    let _ = (bois, chantier, veille, archives);

    // Explicit membership for the private channel (public channels are open to space members).
    add_channel_member(txn, compta, users.admin, "owner").await?;
    add_channel_member(txn, compta, users.alice, "member").await?;
    add_channel_member(txn, compta, users.bob, "member").await?;
    add_channel_member(txn, general, users.admin, "owner").await?;
    add_channel_member(txn, general, users.alice, "member").await?;

    // A file with one version, shared into the general channel.
    let file_id = Uuid::new_v4();
    files::ActiveModel {
        id: Set(file_id),
        space_id: Set(space_id),
        owner_id: Set(Some(users.admin)),
        name: Set("Bilan_2026_v4.ods".to_owned()),
        kind: Set("file-spreadsheet".to_owned()),
        size_bytes: Set(253_952),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    let version_id = Uuid::new_v4();
    file_versions::ActiveModel {
        id: Set(version_id),
        file_id: Set(file_id),
        version_no: Set(1),
        size_bytes: Set(253_952),
        mime_type: Set("application/vnd.oasis.opendocument.spreadsheet".to_owned()),
        created_by: Set(Some(users.admin)),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    // Point the file at its current version (app-maintained pointer, no FK).
    files::ActiveModel {
        id: Set(file_id),
        current_version_id: Set(Some(version_id)),
        ..Default::default()
    }
    .update(txn)
    .await?;
    file_shares::ActiveModel {
        id: Set(Uuid::new_v4()),
        file_id: Set(file_id),
        shared_by: Set(Some(users.admin)),
        target_channel_id: Set(Some(general)),
        permission: Set("view".to_owned()),
        ..Default::default()
    }
    .insert(txn)
    .await?;

    // A system "welcome" notice plus a first message in general.
    insert_system_message(txn, general, "channel_created").await?;
    let welcome = insert_message(
        txn,
        general,
        users.admin,
        "Bienvenue dans l'atelier ! Les annonces passent ici.",
    )
    .await?;

    // A small thread in the private channel: a root with an attachment/reactions, then a reply.
    let root = insert_message(
        txn,
        compta,
        users.admin,
        "Le bilan est pret. Je le depose dans les fichiers du canal, relecture avant vendredi.",
    )
    .await?;
    message_attachments::ActiveModel {
        message_id: Set(root),
        file_id: Set(file_id),
        file_version_id: Set(Some(version_id)),
        position: Set(0),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    add_reaction(txn, root, users.alice, "\u{2705}").await?; // white check mark
    add_reaction(txn, root, users.bob, "\u{1F44D}").await?; // thumbs up
    let reply = insert_reply(
        txn,
        compta,
        users.bob,
        "Recu. Deux ecritures de mars a rapprocher, retour dans la journee.",
        root,
    )
    .await?;
    let _ = reply;
    // Bump the denormalized reply counter on the root.
    messages::ActiveModel {
        id: Set(root),
        reply_count: Set(1),
        ..Default::default()
    }
    .update(txn)
    .await?;

    // A message with a resolved mention and a stored link preview.
    let mention_msg = insert_message(
        txn,
        compta,
        users.alice,
        "Merci @users.bob, je regarde la veille ici: https://boamp.fr",
    )
    .await?;
    message_mentions::ActiveModel {
        message_id: Set(mention_msg),
        mentioned_user_id: Set(users.bob),
        mention_type: Set("user".to_owned()),
    }
    .insert(txn)
    .await?;
    // The API never writes a mention without the notification that goes with it, so neither does
    // this: a mention row on its own is a state the product cannot produce.
    notify_mention(txn, users.bob, compta, mention_msg, users.alice).await?;
    message_link_previews::ActiveModel {
        id: Set(Uuid::new_v4()),
        message_id: Set(mention_msg),
        url: Set("https://boamp.fr".to_owned()),
        domain: Set("boamp.fr".to_owned()),
        title: Set(Some("BOAMP - Appels d'offres".to_owned())),
        description: Set(Some(
            "Bulletin officiel des annonces des marches publics.".to_owned(),
        )),
        ..Default::default()
    }
    .insert(txn)
    .await?;

    // Pin the root message and let users.admin bookmark it.
    channel_pins::ActiveModel {
        channel_id: Set(compta),
        message_id: Set(root),
        pinned_by: Set(Some(users.admin)),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    user_saved_messages::ActiveModel {
        user_id: Set(users.admin),
        message_id: Set(root),
        ..Default::default()
    }
    .insert(txn)
    .await?;

    // A direct message between users.admin and users.alice.
    let dm_id = Uuid::new_v4();
    conversations::ActiveModel {
        id: Set(dm_id),
        space_id: Set(space_id),
        kind: Set("direct".to_owned()),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    dm_conversations::ActiveModel {
        id: Set(dm_id),
        space_id: Set(space_id),
        is_group: Set(false),
        created_by: Set(Some(users.admin)),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    for user in [users.admin, users.alice] {
        dm_participants::ActiveModel {
            dm_id: Set(dm_id),
            user_id: Set(user),
            ..Default::default()
        }
        .insert(txn)
        .await?;
    }
    insert_message(
        txn,
        dm_id,
        users.alice,
        "Salut Camille, tu as deux minutes pour le point compta ?",
    )
    .await?;

    // A direct message from the import assistant (the bot), mirroring the mocked bot DM.
    let bot_dm = Uuid::new_v4();
    conversations::ActiveModel {
        id: Set(bot_dm),
        space_id: Set(space_id),
        kind: Set("direct".to_owned()),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    dm_conversations::ActiveModel {
        id: Set(bot_dm),
        space_id: Set(space_id),
        is_group: Set(false),
        created_by: Set(Some(import_bot)),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    for user in [users.admin, import_bot] {
        dm_participants::ActiveModel {
            dm_id: Set(bot_dm),
            user_id: Set(user),
            ..Default::default()
        }
        .insert(txn)
        .await?;
    }
    insert_message(
        txn,
        bot_dm,
        import_bot,
        "Import Nextcloud termine : 6 comptes, 16 conversations, 92 messages.",
    )
    .await?;

    // A read cursor: users.admin has read up to the welcome message in general.
    read_cursors::ActiveModel {
        conversation_id: Set(general),
        user_id: Set(users.admin),
        last_read_message_id: Set(Some(welcome)),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(())
}

/// The second demo space, which exists so the workspace rail has something to say.
///
/// Deliberately owned by someone else and deliberately left unread for the demo account: it is the
/// space you are *not* looking at, which is exactly where the rail's indicators show. It carries one
/// mention of the demo account, so its tile shows a number; reading that notification turns the
/// number into the plain activity dot, because its messages stay unread. Both states are therefore
/// reachable from one space, without seeding a third.
async fn seed_studio(txn: &DatabaseTransaction, users: &SeedUsers) -> Result<(), DbErr> {
    let space_id = Uuid::new_v4();
    spaces::ActiveModel {
        id: Set(space_id),
        name: Set(STUDIO_NAME.to_owned()),
        slug: Set(STUDIO_SLUG.to_owned()),
        created_by: Set(Some(users.alice)),
        ..Default::default()
    }
    .insert(txn)
    .await?;

    // Alice owns this one and the demo account is only an admin of it, so both "I own this space"
    // and "someone else owns this space" are reachable without leaving either unusable.
    let roster = [
        (users.alice, "owner"),
        (users.admin, "admin"),
        (users.bob, "member"),
        (users.emma, "member"),
    ];
    for (member, role) in roster {
        space_members::ActiveModel {
            space_id: Set(space_id),
            user_id: Set(member),
            role: Set(role.to_owned()),
            invited_by: Set((member != users.alice).then_some(users.alice)),
            ..Default::default()
        }
        .insert(txn)
        .await?;
    }

    let general = create_channel(
        txn,
        space_id,
        users.alice,
        "general",
        "public",
        Some("Vie du studio, annonces et coordination."),
        None,
    )
    .await?;
    let identite = create_channel(
        txn,
        space_id,
        users.alice,
        "identite-visuelle",
        "public",
        Some("Chartes, logos et déclinaisons en cours."),
        None,
    )
    .await?;
    for channel in [general, identite] {
        for (member, role) in roster {
            add_channel_member(
                txn,
                channel,
                member,
                if member == users.alice { "owner" } else { role },
            )
            .await?;
        }
    }

    insert_system_message(txn, general, "channel_created").await?;
    insert_message(
        txn,
        general,
        users.alice,
        "On se cale jeudi 10h pour la revue des maquettes.",
    )
    .await?;
    insert_message(
        txn,
        general,
        users.emma,
        "Noté. J'apporte les impressions papier, le rendu écran ment sur les gris.",
    )
    .await?;

    // A message naming the demo account, with the notification the API would have written with it:
    // this is what puts a number on the tile rather than a plain dot.
    let ping = insert_message(
        txn,
        identite,
        users.emma,
        "@Camille il me manque ton retour sur la déclinaison sombre avant de graver la charte.",
    )
    .await?;
    message_mentions::ActiveModel {
        message_id: Set(ping),
        mentioned_user_id: Set(users.admin),
        mention_type: Set("user".to_owned()),
    }
    .insert(txn)
    .await?;
    notify_mention(txn, users.admin, identite, ping, users.emma).await?;

    // No read cursor for the demo account anywhere here, on purpose: this space has to start unread.
    Ok(())
}

/// Record the in-app notification a mention always produces, unread.
async fn notify_mention(
    txn: &DatabaseTransaction,
    recipient: Uuid,
    conversation_id: Uuid,
    message_id: Uuid,
    actor: Uuid,
) -> Result<(), DbErr> {
    notifications::ActiveModel {
        id: Set(Uuid::new_v4()),
        user_id: Set(recipient),
        kind: Set("mention".to_owned()),
        conversation_id: Set(Some(conversation_id)),
        message_id: Set(Some(message_id)),
        actor_id: Set(Some(actor)),
        read_at: Set(None),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(())
}

/// Refuse to run outside development unless explicitly forced.
fn guard_dev_environment() -> Result<(), Box<dyn std::error::Error>> {
    let is_dev = std::env::var("RUCHOIR_ENV")
        .map(|v| v == "dev")
        .unwrap_or(false);
    let forced = std::env::args().any(|a| a == "--force");
    if is_dev || forced {
        Ok(())
    } else {
        Err("refusing to seed: set RUCHOIR_ENV=dev (or pass --force) to run the dev seed".into())
    }
}

/// Find a user by email, or create it with the shared seed password.
async fn upsert_user(
    txn: &DatabaseTransaction,
    config: &Config,
    email: &str,
    display_name: &str,
) -> Result<Uuid, Box<dyn std::error::Error>> {
    if let Some(existing) = users::Entity::find()
        .filter(users::Column::Email.eq(email))
        .one(txn)
        .await?
    {
        return Ok(existing.id);
    }
    let id = Uuid::new_v4();
    let password_hash =
        auth::hash_password(config, SEED_PASSWORD).map_err(|e| format!("hash failed: {e:?}"))?;
    users::ActiveModel {
        id: Set(id),
        email: Set(email.to_owned()),
        display_name: Set(display_name.to_owned()),
        password_hash: Set(Some(password_hash)),
        status: Set("active".to_owned()),
        mfa_enforced: Set(false),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(id)
}

/// Flag an existing account as an instance administrator. Idempotent.
async fn mark_instance_admin(
    txn: &DatabaseTransaction,
    user_id: Uuid,
) -> Result<(), Box<dyn std::error::Error>> {
    users::Entity::update_many()
        .col_expr(users::Column::IsInstanceAdmin, Expr::value(true))
        .filter(users::Column::Id.eq(user_id))
        .exec(txn)
        .await?;
    Ok(())
}

/// Create a bot account: no password, active, flagged `is_bot`.
async fn create_bot(
    txn: &DatabaseTransaction,
    email: &str,
    display_name: &str,
) -> Result<Uuid, DbErr> {
    let id = Uuid::new_v4();
    users::ActiveModel {
        id: Set(id),
        email: Set(email.to_owned()),
        display_name: Set(display_name.to_owned()),
        password_hash: Set(None),
        status: Set("active".to_owned()),
        mfa_enforced: Set(false),
        is_bot: Set(true),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(id)
}

/// Create a conversation of kind `channel` and its channel row (shared primary key).
async fn create_channel(
    txn: &DatabaseTransaction,
    space_id: Uuid,
    created_by: Uuid,
    name: &str,
    channel_type: &str,
    topic: Option<&str>,
    imported_source: Option<&str>,
) -> Result<Uuid, DbErr> {
    let id = Uuid::new_v4();
    conversations::ActiveModel {
        id: Set(id),
        space_id: Set(space_id),
        kind: Set("channel".to_owned()),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    channels::ActiveModel {
        id: Set(id),
        space_id: Set(space_id),
        name: Set(name.to_owned()),
        channel_type: Set(channel_type.to_owned()),
        topic: Set(topic.map(str::to_owned)),
        created_by: Set(Some(created_by)),
        imported_source: Set(imported_source.map(str::to_owned)),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(id)
}

async fn add_channel_member(
    txn: &DatabaseTransaction,
    channel_id: Uuid,
    user_id: Uuid,
    role: &str,
) -> Result<(), DbErr> {
    channel_members::ActiveModel {
        channel_id: Set(channel_id),
        user_id: Set(user_id),
        role: Set(role.to_owned()),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(())
}

async fn insert_message(
    txn: &DatabaseTransaction,
    conversation_id: Uuid,
    author_id: Uuid,
    body: &str,
) -> Result<Uuid, DbErr> {
    let id = Uuid::new_v4();
    messages::ActiveModel {
        id: Set(id),
        conversation_id: Set(conversation_id),
        author_id: Set(Some(author_id)),
        kind: Set("message".to_owned()),
        body: Set(body.to_owned()),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(id)
}

async fn insert_reply(
    txn: &DatabaseTransaction,
    conversation_id: Uuid,
    author_id: Uuid,
    body: &str,
    parent_message_id: Uuid,
) -> Result<Uuid, DbErr> {
    let id = Uuid::new_v4();
    messages::ActiveModel {
        id: Set(id),
        conversation_id: Set(conversation_id),
        author_id: Set(Some(author_id)),
        kind: Set("message".to_owned()),
        body: Set(body.to_owned()),
        parent_message_id: Set(Some(parent_message_id)),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(id)
}

async fn insert_system_message(
    txn: &DatabaseTransaction,
    conversation_id: Uuid,
    event: &str,
) -> Result<Uuid, DbErr> {
    let id = Uuid::new_v4();
    messages::ActiveModel {
        id: Set(id),
        conversation_id: Set(conversation_id),
        author_id: Set(None),
        kind: Set("system".to_owned()),
        system_event: Set(Some(event.to_owned())),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(id)
}

async fn add_reaction(
    txn: &DatabaseTransaction,
    message_id: Uuid,
    user_id: Uuid,
    emoji: &str,
) -> Result<(), DbErr> {
    message_reactions::ActiveModel {
        message_id: Set(message_id),
        user_id: Set(user_id),
        emoji: Set(emoji.to_owned()),
        ..Default::default()
    }
    .insert(txn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ATELIER_NAME, ATELIER_SLUG, STUDIO_NAME, STUDIO_SLUG};
    use crate::messaging::slug::slugify;

    /// A seeded space must be addressable exactly like one created through the API: same name, same
    /// derived slug. Hard-coding the slug is what keeps the seed readable, so this stops the two
    /// from drifting apart.
    #[test]
    fn demo_slugs_match_what_the_api_would_derive() {
        assert_eq!(slugify(ATELIER_NAME), ATELIER_SLUG);
        assert_eq!(slugify(STUDIO_NAME), STUDIO_SLUG);
    }
}
