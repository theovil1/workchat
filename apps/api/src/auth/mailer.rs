//! Outgoing email over SMTP (verification and password-reset messages).
//!
//! Both TLS dialects are spoken: implicit TLS on port 465, and STARTTLS everywhere else. The port
//! decides, because that is what it means everywhere else in the world and because picking wrong
//! does not fail fast, it hangs.
//!
//! One exception, for development: `RUCHOIR_SMTP_TLS=none` talks to a mail catcher (Mailpit and the
//! like) in clear, since those do not speak TLS out of the box. Configuration refuses it unless the
//! relay is this machine or an internal single-label name ([`is_local_relay`]), so it cannot carry
//! mail across a network.
//!
//! When no SMTP relay is configured (`RUCHOIR_SMTP_HOST` unset), the mailer logs the message for
//! local development instead of sending it, so the flows are testable without a relay. That dev
//! fallback is the ONLY place a token-bearing link is logged, and only when SMTP is unconfigured;
//! production always sets SMTP_HOST and therefore sends.

use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Config;

/// The port on which SMTP is wrapped in TLS from the first byte, rather than upgraded part way.
const IMPLICIT_TLS_PORT: u16 = 465;

/// Builds the SMTP transport for a relay.
///
/// Two ways to wrap SMTP in TLS, and the port says which one a relay speaks. 465 is implicit TLS:
/// the connection is encrypted before a byte of SMTP is sent. Everything else is STARTTLS: the
/// session opens in clear and is upgraded. Trying the wrong one does not fall back, it hangs until
/// it times out, so the choice is made from the port rather than left to a variable nobody would
/// think to set.
fn build_transport(
    host: &str,
    port: u16,
    credentials: Option<(String, String)>,
    plaintext: bool,
) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    if plaintext {
        tracing::warn!(
            host,
            port,
            "SMTP without TLS (RUCHOIR_SMTP_TLS=none): for a local mail catcher only"
        );
        return Ok(
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host)
                .port(port)
                .build(),
        );
    }
    let relay = if port == IMPLICIT_TLS_PORT {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
    };
    let mut builder = relay
        .map_err(|e| format!("invalid SMTP relay: {e}"))?
        .port(port);
    if let Some((user, password)) = credentials {
        builder = builder.credentials(Credentials::new(user, password));
    }
    Ok(builder.build())
}

/// Whether a relay may be spoken to without TLS: this machine, or an internal single-label name
/// such as a Compose service (`mailpit`). Anything with a dot in it is somewhere on a network, and a
/// message crossing one in clear is exactly what the rest of this module exists to prevent.
pub fn is_local_relay(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return false;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback();
    }
    host.eq_ignore_ascii_case("localhost") || !host.contains('.')
}

/// Sends email, or logs it in local dev when no relay is configured.
#[derive(Clone)]
pub struct Mailer {
    transport: Option<AsyncSmtpTransport<Tokio1Executor>>,
    from: String,
    /// Public base URL used to build links in email bodies.
    pub base_url: String,
}

impl Mailer {
    /// Build the mailer from configuration. Returns an error only on an invalid SMTP host.
    pub fn from_config(config: &Config) -> Result<Self, String> {
        let transport = match config.smtp_host.as_deref() {
            Some(host) if !host.is_empty() => Some(build_transport(
                host,
                config.smtp_port,
                config
                    .smtp_username
                    .clone()
                    .zip(config.smtp_password.clone()),
                config.smtp_plaintext,
            )?),
            _ => None,
        };
        Ok(Self {
            transport,
            from: config.smtp_from.clone(),
            base_url: config.public_base_url.clone(),
        })
    }

    /// Whether this instance can actually deliver mail.
    ///
    /// [`Self::send`] answers `Ok` with no relay configured, because logging the message is the
    /// right behaviour for local development. Anything that *reports* a delivery to a person must
    /// ask this first: telling an administrator "the email is on its way" when it went to a log
    /// file is exactly the kind of lie the interface is being cleaned of.
    pub fn can_send(&self) -> bool {
        self.transport.is_some()
    }

    /// This instance as a reader recognises it (`chat.example.org`), for the line at the foot of a
    /// message saying where it came from.
    pub fn instance_name(&self) -> String {
        let url = self.base_url.trim_end_matches('/');
        url.split_once("://")
            .map_or(url, |(_, rest)| rest)
            .to_owned()
    }

    /// Send an email: its HTML, with the Ruchoir mark embedded, and its plain-text alternative. In
    /// dev (no relay) the plain text is logged instead.
    pub async fn send(&self, to: &str, email: &super::mail_text::Email) -> Result<(), String> {
        let subject = &email.subject;
        let Some(transport) = &self.transport else {
            let body = &email.text;
            tracing::info!(%to, %subject, "email not sent (no SMTP relay configured); body follows for dev:\n{body}");
            return Ok(());
        };
        let from: Mailbox = self
            .from
            .parse()
            .map_err(|e| format!("invalid From: {e}"))?;
        let to: Mailbox = to.parse().map_err(|e| format!("invalid To: {e}"))?;
        // multipart/alternative: plain text first, the richer part last, as the standard orders them.
        // The HTML travels with its logo in a multipart/related, so it is shown without fetching.
        let logo = Attachment::new_inline(super::mail_text::LOGO_CID.to_owned()).body(
            super::mail_text::LOGO_PNG.to_vec(),
            ContentType::parse("image/png").map_err(|e| format!("content type: {e}"))?,
        );
        let body = MultiPart::alternative()
            .singlepart(SinglePart::plain(email.text.clone()))
            .multipart(
                MultiPart::related()
                    .singlepart(SinglePart::html(email.html.clone()))
                    .singlepart(logo),
            );
        // An invitation travels with its `.ics`, which mail clients offer to add to a calendar.
        let body = match &email.calendar {
            None => body,
            Some(part) => MultiPart::mixed().multipart(body).singlepart(
                Attachment::new("invitation.ics".to_owned()).body(
                    part.body.clone(),
                    ContentType::parse(&format!(
                        "text/calendar; charset=utf-8; method={}",
                        part.method
                    ))
                    .map_err(|e| format!("content type: {e}"))?,
                ),
            ),
        };
        let message = Message::builder()
            .from(from)
            .to(to)
            .subject(subject.as_str())
            .multipart(body)
            .map_err(|e| format!("could not build email: {e}"))?;
        transport
            .send(message)
            .await
            .map_err(|e| format!("could not send email: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relay_on_465_is_built_with_implicit_tls() {
        // Both dialects have to build: the relay a customer already pays for decides the port,
        // and until this existed a 465-only relay simply hung.
        assert!(build_transport("smtp.example.org", 465, None, false).is_ok());
    }

    #[test]
    fn a_relay_on_587_is_built_with_starttls() {
        assert!(build_transport("smtp.example.org", 587, None, false).is_ok());
    }

    #[test]
    fn credentials_are_optional_because_some_relays_authenticate_by_address() {
        let with = build_transport(
            "smtp.example.org",
            587,
            Some(("user".into(), "secret".into())),
            false,
        );
        assert!(with.is_ok());
    }

    #[test]
    fn a_relay_in_clear_is_only_ever_this_machine_or_an_internal_name() {
        for local in ["mailpit", "localhost", "127.0.0.1", "::1", "[::1]"] {
            assert!(is_local_relay(local), "{local} should be allowed");
        }
        for remote in [
            "smtp.example.org",
            "mailpit.lan",
            "192.168.1.20",
            "10.0.0.5",
            "",
        ] {
            assert!(!is_local_relay(remote), "{remote} must not be");
        }
        assert!(build_transport("mailpit", 1025, None, true).is_ok());
    }
}
