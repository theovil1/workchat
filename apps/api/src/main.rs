//! Ruchoir API entrypoint.
//!
//! Initializes structured logging, loads configuration, connects to PostgreSQL and Valkey,
//! applies database migrations (automatically in dev, or via the `migrate` subcommand), and
//! serves an HTTP surface: health endpoints plus the exported static web bundle. Auth,
//! real-time transport and richer business logic build on this foundation in later stages.

mod admin;
mod auth;
mod bootstrap;
mod cache;
mod calendar;
mod config;
mod db;
mod entities;
mod files;
mod http;
mod importer;
mod messaging;
mod notify;
mod office;
mod og;
mod openapi;
mod realtime;
mod seed;
mod state;
mod storage;

#[cfg(test)]
mod tests_integration;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

use ruchoir_migration::{Migrator, MigratorTrait};
use tracing_subscriber::{fmt, EnvFilter};

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() -> ExitCode {
    // Load a local `.env` for `cargo run` convenience. Real environment variables always win, so
    // this never overrides values injected by Docker / production.
    let _ = dotenvy::dotenv();
    init_tracing();

    let config = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(err) => {
            tracing::error!(error = %err, "invalid configuration");
            return ExitCode::FAILURE;
        }
    };

    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!(error = %err, "fatal error");
            ExitCode::FAILURE
        }
    }
}

/// Wire up datastores, run migrations as configured, and either serve or handle a subcommand.
async fn run(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    // Subcommand dispatch. `ruchoir-api migrate` applies pending migrations and exits: this is
    // the explicit, production-safe path. Regular startup serves the app.
    let subcommand = std::env::args().nth(1);

    // `ruchoir-api import-check <archive> [passphrase]` reads an archive and reports whether it
    // holds together. Dispatched before the database is touched, because checking an export has
    // nothing to do with a running instance: an administrator does it on the machine that produced
    // the file, before uploading gigabytes only to be told no.
    if subcommand.as_deref() == Some("import-check") {
        let path = std::env::args()
            .nth(2)
            .ok_or("usage: import-check <archive> [passphrase]")?;
        let passphrase = std::env::args().nth(3);
        return importer::check_command(std::path::Path::new(&path), passphrase.as_deref())
            .map_err(|e| e.into());
    }

    // `ruchoir-api mail-preview <address>` sends every message the server writes, in every
    // language, with sample content, through the configured relay: how their design and wording are
    // reviewed without registering, resetting and inviting eighteen times. Pointed at a mail catcher
    // in development; it touches no database.
    if subcommand.as_deref() == Some("mail-preview") {
        let to = std::env::args()
            .nth(2)
            .ok_or("usage: mail-preview <address>")?;
        return auth::mail_text::send_previews(&config, &to)
            .await
            .map_err(|e| e.into());
    }

    let db = db::connect(&config).await?;
    tracing::info!("connected to PostgreSQL");

    if subcommand.as_deref() == Some("migrate") {
        tracing::info!("applying database migrations");
        Migrator::up(&db, None).await?;
        tracing::info!("migrations applied");
        return Ok(());
    }

    // `ruchoir-api seed` populates a dev workspace and exits. It applies migrations first so a
    // fresh database can be seeded in one step, and refuses to run outside development.
    if subcommand.as_deref() == Some("seed") {
        tracing::info!("applying migrations before seeding");
        Migrator::up(&db, None).await?;
        seed::run(&db, &config).await?;
        return Ok(());
    }

    // `ruchoir-api bootstrap` creates the first administrator of a fresh instance and exits.
    // Migrations first, so a brand-new database goes from empty to usable in two commands.
    if subcommand.as_deref() == Some("bootstrap") {
        tracing::info!("applying migrations before bootstrapping");
        Migrator::up(&db, None).await?;
        bootstrap::run(&db, &config).await?;
        return Ok(());
    }

    // `ruchoir-api import <archive> <administrator address> [passphrase]` runs a whole import from
    // a file already on the server: the path for an archive too large to upload, on a machine the
    // administrator already has a shell on. Migrations first, so a fresh instance can be filled in
    // two commands.
    if subcommand.as_deref() == Some("import") {
        let path = std::env::args()
            .nth(2)
            .ok_or("usage: import <archive> <administrator address> [passphrase]")?;
        let admin = std::env::args()
            .nth(3)
            .ok_or("usage: import <archive> <administrator address> [passphrase]")?;
        let passphrase = std::env::args().nth(4);
        Migrator::up(&db, None).await?;
        let storage = if config.s3_enabled() {
            storage::S3Store::from_config(&config).ok()
        } else {
            None
        };
        return importer::import_command(
            &db,
            storage.as_ref(),
            std::path::Path::new(&path),
            &admin,
            passphrase.as_deref(),
            config.thumbnail_max_px,
        )
        .await
        .map_err(|e| e.into());
    }

    // In development the API applies pending migrations on boot for convenience. Production sets
    // RUCHOIR_AUTO_MIGRATE=false and runs the `migrate` subcommand explicitly before deploying.
    if config.auto_migrate {
        tracing::info!("auto-migrate enabled; applying pending migrations");
        Migrator::up(&db, None).await?;
    }

    let valkey = cache::connect(&config).await?;
    tracing::info!("connected to Valkey");

    // An import runs in a task inside this process, so anything still marked as running when we
    // get here is something no task is behind any more. Said now, before a screen can watch a bar
    // that would never move again.
    match importer::run::close_abandoned_jobs(&db).await {
        Ok(0) => {}
        Ok(closed) => tracing::warn!(closed, "imports were interrupted by a restart"),
        Err(error) => tracing::warn!(%error, "could not close interrupted imports"),
    }

    // Real-time hub: opens a dedicated pub/sub subscriber and starts the fan-out loop.
    let hub = realtime::Hub::start(&config, valkey.clone()).await?;
    tracing::info!("real-time hub started");

    let mailer = auth::mailer::Mailer::from_config(&config)?;
    if config.smtp_host.is_none() {
        tracing::warn!("no SMTP relay configured; emails will be logged, not sent (dev only)");
    }

    let breaches = match &config.breached_pw_bloom_path {
        Some(path) => match auth::breach::BreachFilter::from_path(path) {
            Ok(filter) => {
                tracing::info!(path = %path.display(), "loaded breached-password filter");
                filter
            }
            Err(err) => {
                tracing::warn!(error = %err, "could not load breached-password filter; check disabled");
                auth::breach::BreachFilter::disabled()
            }
        },
        None => {
            tracing::warn!("no breached-password filter configured; breach check disabled");
            auth::breach::BreachFilter::disabled()
        }
    };

    let secret_key = match std::env::var("RUCHOIR_SECRET_ENCRYPTION_KEY") {
        Ok(hex) => decode_key_hex(&hex)
            .ok_or("RUCHOIR_SECRET_ENCRYPTION_KEY must be 64 hex characters (32 bytes)")?,
        Err(_) => {
            tracing::warn!(
                "RUCHOIR_SECRET_ENCRYPTION_KEY unset; using an INSECURE built-in dev key \
                 (never use in production)"
            );
            DEV_SECRET_KEY
        }
    };

    let webauthn = {
        let origin = webauthn_rs::prelude::Url::parse(&config.webauthn_origin)
            .map_err(|e| format!("invalid RUCHOIR_WEBAUTHN_ORIGIN: {e}"))?;
        webauthn_rs::WebauthnBuilder::new(&config.webauthn_rp_id, &origin)
            .map_err(|e| format!("webauthn configuration: {e}"))?
            .rp_name("Ruchoir")
            .build()
            .map_err(|e| format!("webauthn configuration: {e}"))?
    };

    // Object store for file bytes. Optional: with no credentials the API still serves metadata and
    // the file tree, and the byte endpoints report 503 (like the optional mailer / breach filter).
    let storage = if config.s3_enabled() {
        match storage::S3Store::from_config(&config) {
            Ok(store) => {
                // Reachability is checked here, once, rather than discovered on someone's first
                // upload as a 502. A configured store that is not set up is the most likely state of
                // a fresh install, and the remedy is one command, so the log names it.
                match store.probe().await {
                    Ok(()) => tracing::info!(
                        endpoint = %config.s3_endpoint, bucket = %config.s3_bucket,
                        "object store ready"
                    ),
                    Err(err) => tracing::warn!(
                        error = %err, endpoint = %config.s3_endpoint, bucket = %config.s3_bucket,
                        "object store configured but not reachable; file uploads will fail. \
                         If this is a fresh install, run scripts/bootstrap-garage.sh"
                    ),
                }
                Some(Arc::new(store))
            }
            Err(err) => {
                tracing::error!(error = %err, "could not configure object store; file bytes disabled");
                None
            }
        }
    } else {
        tracing::warn!("no S3 credentials configured; file byte storage disabled (metadata only)");
        None
    };

    let office = office::Office::from_config(&config).map(Arc::new);
    match &office {
        Some(office) => {
            tracing::info!(public = %office.public_origin(), "live office editing enabled");
            office::spawn_discovery_refresh(office.clone());
        }
        None => tracing::info!("live office editing not configured"),
    }

    let state = AppState {
        db,
        valkey,
        mailer,
        breaches: Arc::new(breaches),
        secret_key: Arc::new(secret_key),
        webauthn: Arc::new(webauthn),
        hub,
        storage,
        office,
        config: Arc::new(config),
    };

    // The unread-notification email fallback: a sweep a minute, in the background.
    notify::email::spawn(state.clone());
    // The trash lets go of what has been in it past the retention: a sweep an hour.
    files::trash::spawn(state.clone());
    // Calendar reminders, every minute.
    calendar::reminders::spawn(state.clone());
    // Who is editing what: a tab that died without a goodbye leaves the file lists by itself.
    if state.office.is_some() {
        office::presence::spawn_sweep(state.clone());
    }

    tracing::info!(
        addr = %state.config.addr,
        web_dist = %state.config.web_dist.display(),
        "starting ruchoir-api"
    );

    serve(state).await
}

/// Insecure development fallback for the secret-encryption key. Production MUST set
/// `RUCHOIR_SECRET_ENCRYPTION_KEY` to a real 32-byte key (64 hex characters).
const DEV_SECRET_KEY: [u8; 32] = [0x11; 32];

/// Decode a 64-character hex string into 32 bytes.
fn decode_key_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(hex.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

/// Configure structured, filtered logging. Never logs secrets.
fn init_tracing() {
    let filter = EnvFilter::try_from_env("RUST_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    fmt().with_env_filter(filter).init();
}

/// Serve the application, selecting HTTPS when TLS material is configured and the
/// `tls` feature is built in, otherwise plain HTTP for local development.
async fn serve(state: AppState) -> Result<(), Box<dyn std::error::Error>> {
    if state.office.is_some() {
        tokio::spawn(serve_wopi(state.clone()));
    }
    let addr = state.config.addr;
    let app = http::router(state.clone());

    #[cfg(feature = "tls")]
    if state.config.tls_enabled() {
        return serve_tls(state, app).await;
    }

    #[cfg(not(feature = "tls"))]
    if state.config.tls_enabled() {
        tracing::warn!(
            "TLS certificate/key are set but this binary was built without the `tls` feature; \
             serving plain HTTP"
        );
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    // Report the actual bound address: with RUCHOIR_API_PORT=0 the OS picks a free port.
    let local_addr = listener.local_addr().unwrap_or(addr);
    tracing::info!("listening on http://{}", local_addr);
    // Connect-info is required so the rate limiter can fall back to the connection peer IP when
    // no forwarded-for header is present (direct dev connections).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// The internal WOPI listener the office engine calls. Never published (see `crate::office`).
async fn serve_wopi(state: AppState) {
    let addr = state.config.wopi_listen;
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            tracing::info!("WOPI listener on http://{addr}");
            if let Err(error) = axum::serve(listener, office::wopi_router(state)).await {
                tracing::error!(%error, "WOPI listener stopped");
            }
        }
        Err(error) => {
            tracing::error!(%error, %addr, "could not bind the WOPI listener; live editing cannot save");
        }
    }
}

/// Serve over HTTPS using rustls with the community `ring` crypto provider.
#[cfg(feature = "tls")]
async fn serve_tls(state: AppState, app: axum::Router) -> Result<(), Box<dyn std::error::Error>> {
    use axum_server::tls_rustls::RustlsConfig;

    // Install the `ring` provider explicitly. `aws-lc-rs` (the rustls default) is
    // avoided per the no-US-dependency rule.
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "failed to install rustls ring crypto provider")?;

    let cert = state.config.tls_cert.as_ref().expect("tls_enabled checked");
    let key = state.config.tls_key.as_ref().expect("tls_enabled checked");
    let tls = RustlsConfig::from_pem_file(cert, key).await?;

    tracing::info!("listening on https://{}", state.config.addr);
    axum_server::bind_rustls(state.config.addr, tls)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
        .await?;
    Ok(())
}

/// Resolve when the process receives Ctrl-C or (on Unix) SIGTERM, enabling a
/// graceful shutdown of in-flight requests.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    tracing::info!("shutdown signal received");
}
