//! The emails the server sends, in the six languages the product speaks, as a designed HTML message
//! with a plain-text alternative, plus the few words a push notification needs.
//!
//! Kept in Rust rather than pulled from the web bundle's dictionaries: the API must be able to send
//! a password reset with no web build present, and these are four messages, not an interface. A
//! translation crate would add a dependency, a file format and a loader for less text than this
//! module holds.
//!
//! Each message is written once, as content (a heading, a paragraph, a button, a note), and drawn
//! twice from it: as HTML in Ruchoir's colours, and as plain text for the clients that read that
//! instead. The two can therefore never say different things.
//!
//! Which language a message goes out in:
//!
//! - **Verification and password reset** use the language of the page that asked for them when
//!   there was one (the person reading the page is the person who will read the message), and the
//!   account's own language (`users.locale`) otherwise. Unset means French, the source language.
//! - **An invitation** uses the invited person's own language when they already have an account
//!   here, and the language of whoever issued it otherwise: nothing is known about a newcomer, and
//!   the person inviting them has just typed their address and presumably shares a working
//!   language with them.
//! - **The unread digest** (and a push notification's text) use the account's own language: nobody
//!   asked for them from a page, they are addressed to the account.

use std::fmt;

/// A language the server can write in. Mirrors `apps/web/lib/i18n/config.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    Fr,
    En,
    Es,
    De,
    It,
    Pl,
}

impl Locale {
    /// Parse a stored or submitted tag. Anything unknown falls back to the source language rather
    /// than failing: a message in French beats no message at all.
    pub fn parse(value: Option<&str>) -> Self {
        match value.unwrap_or("").split(['-', '_']).next().unwrap_or("") {
            "en" => Locale::En,
            "es" => Locale::Es,
            "de" => Locale::De,
            "it" => Locale::It,
            "pl" => Locale::Pl,
            _ => Locale::Fr,
        }
    }

    /// The tag as stored, so a round trip through the database is lossless.
    pub fn as_str(self) -> &'static str {
        match self {
            Locale::Fr => "fr",
            Locale::En => "en",
            Locale::Es => "es",
            Locale::De => "de",
            Locale::It => "it",
            Locale::Pl => "pl",
        }
    }
}

impl fmt::Display for Locale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A ready-to-send message: its subject, and its body twice (plain text and HTML).
pub struct Email {
    pub subject: String,
    pub text: String,
    pub html: String,
}

/// The `Content-ID` the HTML refers to for the Ruchoir mark, which travels inside the message.
///
/// Embedded rather than fetched: most mail clients block remote images until the reader allows
/// them, and a logo shown as a broken frame is worse than no logo.
pub const LOGO_CID: &str = "ruchoir-mark";

/// The mark itself, 256 px, drawn at 36 so it stays sharp on a dense screen.
pub const LOGO_PNG: &[u8] = include_bytes!("../../assets/mail-mark.png");

/// What one message says, before it is drawn.
struct Content {
    subject: String,
    /// The line a mail client shows next to the subject in the inbox. Hidden in the message itself.
    preheader: String,
    heading: String,
    paragraph: String,
    button: String,
    link: String,
    /// Expiry and "not you?": small, under the button.
    note: String,
    /// A list drawn between the paragraph and the button. Empty for every message but the digest.
    items: Vec<DigestItem>,
}

/// One line of the unread digest: what happened, and the first words of the message.
#[derive(Debug, Clone)]
pub struct DigestItem {
    /// "Camille vous a mentionné · #général".
    pub headline: String,
    /// A one-line excerpt of the message. May be empty (an attachment alone).
    pub excerpt: String,
}

/// What every message says the same way, per language.
struct Common {
    tagline: &'static str,
    fallback: &'static str,
    sent_by: &'static str,
}

fn common(locale: Locale) -> Common {
    match locale {
        Locale::Fr => Common {
            tagline: "Une ruche pour tout votre travail.",
            fallback: "Le bouton ne fonctionne pas ? Copiez ce lien dans votre navigateur :",
            sent_by: "Envoyé par",
        },
        Locale::En => Common {
            tagline: "One hive for all your work.",
            fallback: "Button not working? Copy this link into your browser:",
            sent_by: "Sent by",
        },
        Locale::Es => Common {
            tagline: "Una colmena para todo tu trabajo.",
            fallback: "¿El botón no funciona? Copia este enlace en tu navegador:",
            sent_by: "Enviado por",
        },
        Locale::De => Common {
            tagline: "Ein Bienenstock für Ihre gesamte Arbeit.",
            fallback: "Der Button funktioniert nicht? Kopieren Sie diesen Link in Ihren Browser:",
            sent_by: "Gesendet von",
        },
        Locale::It => Common {
            tagline: "Un alveare per tutto il tuo lavoro.",
            fallback: "Il pulsante non funziona? Copia questo link nel tuo browser:",
            sent_by: "Inviato da",
        },
        Locale::Pl => Common {
            tagline: "Jeden ul dla całej Twojej pracy.",
            fallback: "Przycisk nie działa? Skopiuj ten link do przeglądarki:",
            sent_by: "Wysłano z",
        },
    }
}

/// Confirm a newly registered address.
pub fn verification(locale: Locale, link: &str, hours: i64, instance: &str) -> Email {
    let link = link.to_owned();
    let content = match locale {
        Locale::Fr => Content {
            subject: "Confirmez votre adresse Ruchoir".to_owned(),
            preheader: "Une dernière étape pour activer votre compte.".to_owned(),
            heading: "Confirmez votre adresse".to_owned(),
            paragraph: "Bienvenue sur Ruchoir. Il reste une étape : confirmer que cette adresse est bien la vôtre, pour activer votre compte.".to_owned(),
            button: "Confirmer mon adresse".to_owned(),
            link,
            note: format!("Ce lien expire dans {hours} heures. Si vous n'avez pas créé de compte Ruchoir, ignorez ce message : aucun compte ne sera activé."),
            items: Vec::new(),
        },
        Locale::En => Content {
            subject: "Confirm your Ruchoir email".to_owned(),
            preheader: "One last step to activate your account.".to_owned(),
            heading: "Confirm your email address".to_owned(),
            paragraph: "Welcome to Ruchoir. One step left: confirm that this address is yours, to activate your account.".to_owned(),
            button: "Confirm my address".to_owned(),
            link,
            note: format!("This link expires in {hours} hours. If you did not create a Ruchoir account, ignore this message: no account will be activated."),
            items: Vec::new(),
        },
        Locale::Es => Content {
            subject: "Confirma tu dirección de Ruchoir".to_owned(),
            preheader: "Un último paso para activar tu cuenta.".to_owned(),
            heading: "Confirma tu dirección".to_owned(),
            paragraph: "Te damos la bienvenida a Ruchoir. Queda un paso: confirmar que esta dirección es tuya para activar tu cuenta.".to_owned(),
            button: "Confirmar mi dirección".to_owned(),
            link,
            note: format!("Este enlace caduca en {hours} horas. Si no has creado ninguna cuenta de Ruchoir, ignora este mensaje: no se activará ninguna cuenta."),
            items: Vec::new(),
        },
        Locale::De => Content {
            subject: "Bestätigen Sie Ihre Ruchoir-Adresse".to_owned(),
            preheader: "Ein letzter Schritt, um Ihr Konto zu aktivieren.".to_owned(),
            heading: "Bestätigen Sie Ihre Adresse".to_owned(),
            paragraph: "Willkommen bei Ruchoir. Nur noch ein Schritt: Bestätigen Sie, dass diese Adresse Ihnen gehört, um Ihr Konto zu aktivieren.".to_owned(),
            button: "Adresse bestätigen".to_owned(),
            link,
            note: format!("Dieser Link läuft in {hours} Stunden ab. Falls Sie kein Ruchoir-Konto erstellt haben, ignorieren Sie diese Nachricht: Es wird kein Konto aktiviert."),
            items: Vec::new(),
        },
        Locale::It => Content {
            subject: "Conferma il tuo indirizzo Ruchoir".to_owned(),
            preheader: "Un ultimo passaggio per attivare il tuo account.".to_owned(),
            heading: "Conferma il tuo indirizzo".to_owned(),
            paragraph: "Benvenuto su Ruchoir. Manca un passaggio: conferma che questo indirizzo è tuo per attivare il tuo account.".to_owned(),
            button: "Conferma il mio indirizzo".to_owned(),
            link,
            note: format!("Questo link scade tra {hours} ore. Se non hai creato un account Ruchoir, ignora questo messaggio: nessun account verrà attivato."),
            items: Vec::new(),
        },
        Locale::Pl => Content {
            subject: "Potwierdź swój adres w Ruchoirze".to_owned(),
            preheader: "Ostatni krok, aby aktywować konto.".to_owned(),
            heading: "Potwierdź swój adres".to_owned(),
            paragraph: "Witamy w Ruchoirze. Został jeden krok: potwierdź, że ten adres należy do Ciebie, aby aktywować konto.".to_owned(),
            button: "Potwierdź adres".to_owned(),
            link,
            note: format!("Link wygasa za {hours} godz. Jeśli nie zakładałeś konta w Ruchoirze, zignoruj tę wiadomość: żadne konto nie zostanie aktywowane."),
            items: Vec::new(),
        },
    };
    render(locale, &content, instance)
}

/// Hand back an account whose password was forgotten.
pub fn password_reset(locale: Locale, link: &str, minutes: i64, instance: &str) -> Email {
    let link = link.to_owned();
    let content = match locale {
        Locale::Fr => Content {
            subject: "Réinitialisez votre mot de passe Ruchoir".to_owned(),
            preheader: "Choisissez un nouveau mot de passe pour votre compte.".to_owned(),
            heading: "Réinitialisez votre mot de passe".to_owned(),
            paragraph: "Une réinitialisation du mot de passe a été demandée pour le compte Ruchoir associé à cette adresse.".to_owned(),
            button: "Choisir un nouveau mot de passe".to_owned(),
            link,
            note: format!("Ce lien expire dans {minutes} minutes et ne sert qu'une fois. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé."),
            items: Vec::new(),
        },
        Locale::En => Content {
            subject: "Reset your Ruchoir password".to_owned(),
            preheader: "Choose a new password for your account.".to_owned(),
            heading: "Reset your password".to_owned(),
            paragraph: "A password reset was requested for the Ruchoir account linked to this address.".to_owned(),
            button: "Choose a new password".to_owned(),
            link,
            note: format!("This link expires in {minutes} minutes and works once. If you did not request this, ignore this message: your password stays as it is."),
            items: Vec::new(),
        },
        Locale::Es => Content {
            subject: "Restablece tu contraseña de Ruchoir".to_owned(),
            preheader: "Elige una nueva contraseña para tu cuenta.".to_owned(),
            heading: "Restablece tu contraseña".to_owned(),
            paragraph: "Se ha solicitado restablecer la contraseña de la cuenta de Ruchoir asociada a esta dirección.".to_owned(),
            button: "Elegir una nueva contraseña".to_owned(),
            link,
            note: format!("Este enlace caduca en {minutes} minutos y solo sirve una vez. Si no has sido tú, ignora este mensaje: tu contraseña no cambia."),
            items: Vec::new(),
        },
        Locale::De => Content {
            subject: "Setzen Sie Ihr Ruchoir-Passwort zurück".to_owned(),
            preheader: "Legen Sie ein neues Passwort für Ihr Konto fest.".to_owned(),
            heading: "Passwort zurücksetzen".to_owned(),
            paragraph: "Für das Ruchoir-Konto mit dieser Adresse wurde das Zurücksetzen des Passworts angefordert.".to_owned(),
            button: "Neues Passwort festlegen".to_owned(),
            link,
            note: format!("Dieser Link läuft in {minutes} Minuten ab und funktioniert nur einmal. Falls die Anfrage nicht von Ihnen stammt, ignorieren Sie diese Nachricht: Ihr Passwort bleibt unverändert."),
            items: Vec::new(),
        },
        Locale::It => Content {
            subject: "Reimposta la tua password Ruchoir".to_owned(),
            preheader: "Scegli una nuova password per il tuo account.".to_owned(),
            heading: "Reimposta la tua password".to_owned(),
            paragraph: "È stata richiesta la reimpostazione della password per l'account Ruchoir associato a questo indirizzo.".to_owned(),
            button: "Scegli una nuova password".to_owned(),
            link,
            note: format!("Questo link scade tra {minutes} minuti e funziona una sola volta. Se non sei stato tu, ignora questo messaggio: la tua password resta invariata."),
            items: Vec::new(),
        },
        Locale::Pl => Content {
            subject: "Zresetuj hasło do Ruchoira".to_owned(),
            preheader: "Ustaw nowe hasło do swojego konta.".to_owned(),
            heading: "Zresetuj hasło".to_owned(),
            paragraph: "Zażądano zresetowania hasła do konta w Ruchoirze powiązanego z tym adresem.".to_owned(),
            button: "Ustaw nowe hasło".to_owned(),
            link,
            note: format!("Link wygasa za {minutes} min i działa tylko raz. Jeśli to nie Ty, zignoruj tę wiadomość: Twoje hasło pozostanie bez zmian."),
            items: Vec::new(),
        },
    };
    render(locale, &content, instance)
}

/// Invite someone into a space. `inviter` is the display name of whoever issued it, when known.
pub fn invitation(
    locale: Locale,
    space: &str,
    inviter: Option<&str>,
    link: &str,
    instance: &str,
) -> Email {
    let link = link.to_owned();
    let content = match locale {
        Locale::Fr => Content {
            subject: format!("Rejoignez {space} sur Ruchoir"),
            preheader: format!("Une invitation vous attend dans l'espace {space}."),
            heading: format!("Rejoignez {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} vous invite à rejoindre l'espace {space} sur Ruchoir : les conversations, les fils de discussion et les fichiers de l'équipe, au même endroit."),
                None => format!("On vous invite à rejoindre l'espace {space} sur Ruchoir : les conversations, les fils de discussion et les fichiers de l'équipe, au même endroit."),
            },
            button: "Accepter l'invitation".to_owned(),
            link,
            note: "Si vous ne vous attendiez pas à cette invitation, ignorez ce message.".to_owned(),
            items: Vec::new(),
        },
        Locale::En => Content {
            subject: format!("Join {space} on Ruchoir"),
            preheader: format!("An invitation is waiting for you in {space}."),
            heading: format!("Join {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} invited you to join the {space} space on Ruchoir: the team's conversations, threads and files, in one place."),
                None => format!("You have been invited to join the {space} space on Ruchoir: the team's conversations, threads and files, in one place."),
            },
            button: "Accept the invitation".to_owned(),
            link,
            note: "If you were not expecting this invitation, ignore this message.".to_owned(),
            items: Vec::new(),
        },
        Locale::Es => Content {
            subject: format!("Únete a {space} en Ruchoir"),
            preheader: format!("Te espera una invitación en {space}."),
            heading: format!("Únete a {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} te invita a unirte al espacio {space} en Ruchoir: las conversaciones, los hilos y los archivos del equipo, en un solo lugar."),
                None => format!("Te han invitado a unirte al espacio {space} en Ruchoir: las conversaciones, los hilos y los archivos del equipo, en un solo lugar."),
            },
            button: "Aceptar la invitación".to_owned(),
            link,
            note: "Si no esperabas esta invitación, ignora este mensaje.".to_owned(),
            items: Vec::new(),
        },
        Locale::De => Content {
            subject: format!("Treten Sie {space} auf Ruchoir bei"),
            preheader: format!("In {space} wartet eine Einladung auf Sie."),
            heading: format!("Treten Sie {space} bei"),
            paragraph: match inviter {
                Some(who) => format!("{who} lädt Sie in den Bereich {space} auf Ruchoir ein: Unterhaltungen, Threads und Dateien des Teams an einem Ort."),
                None => format!("Sie wurden in den Bereich {space} auf Ruchoir eingeladen: Unterhaltungen, Threads und Dateien des Teams an einem Ort."),
            },
            button: "Einladung annehmen".to_owned(),
            link,
            note: "Falls Sie diese Einladung nicht erwartet haben, ignorieren Sie diese Nachricht.".to_owned(),
            items: Vec::new(),
        },
        Locale::It => Content {
            subject: format!("Unisciti a {space} su Ruchoir"),
            preheader: format!("Ti aspetta un invito in {space}."),
            heading: format!("Unisciti a {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} ti invita a unirti allo spazio {space} su Ruchoir: le conversazioni, le discussioni e i file del team, in un unico posto."),
                None => format!("Sei stato invitato a unirti allo spazio {space} su Ruchoir: le conversazioni, le discussioni e i file del team, in un unico posto."),
            },
            button: "Accetta l'invito".to_owned(),
            link,
            note: "Se non ti aspettavi questo invito, ignora questo messaggio.".to_owned(),
            items: Vec::new(),
        },
        Locale::Pl => Content {
            subject: format!("Dołącz do {space} w Ruchoirze"),
            preheader: format!("Czeka na Ciebie zaproszenie do {space}."),
            heading: format!("Dołącz do {space}"),
            paragraph: match inviter {
                Some(who) => format!("{who} zaprasza Cię do przestrzeni {space} w Ruchoirze: rozmowy, wątki i pliki zespołu w jednym miejscu."),
                None => format!("Otrzymujesz zaproszenie do przestrzeni {space} w Ruchoirze: rozmowy, wątki i pliki zespołu w jednym miejscu."),
            },
            button: "Przyjmij zaproszenie".to_owned(),
            link,
            note: "Jeśli nie spodziewałeś się tego zaproszenia, zignoruj tę wiadomość.".to_owned(),
            items: Vec::new(),
        },
    };
    render(locale, &content, instance)
}

/// What happened, as a short verb phrase after the actor's name, per notification kind. The same
/// words as the web inbox (`notif.mentioned`, `notif.broadcast`, ...), so a push, an email and the
/// app describe one event the same way.
pub fn notification_verb(locale: Locale, kind: &str) -> &'static str {
    match (locale, kind) {
        (Locale::Fr, "mention") => "vous a mentionné",
        (Locale::Fr, "broadcast") => "a mentionné tout le canal",
        (Locale::Fr, "reply") => "a répondu dans un fil",
        (Locale::Fr, "message") => "a écrit",
        (Locale::Fr, _) => "vous a envoyé un message",
        (Locale::En, "mention") => "mentioned you",
        (Locale::En, "broadcast") => "mentioned the whole channel",
        (Locale::En, "reply") => "replied in a thread",
        (Locale::En, "message") => "wrote",
        (Locale::En, _) => "sent you a message",
        (Locale::Es, "mention") => "te ha mencionado",
        (Locale::Es, "broadcast") => "ha mencionado a todo el canal",
        (Locale::Es, "reply") => "ha respondido en un hilo",
        (Locale::Es, "message") => "ha escrito",
        (Locale::Es, _) => "te ha enviado un mensaje",
        (Locale::De, "mention") => "hat Sie erwähnt",
        (Locale::De, "broadcast") => "hat den ganzen Kanal erwähnt",
        (Locale::De, "reply") => "hat in einem Thread geantwortet",
        (Locale::De, "message") => "hat geschrieben",
        (Locale::De, _) => "hat Ihnen eine Nachricht geschickt",
        (Locale::It, "mention") => "ti ha menzionato",
        (Locale::It, "broadcast") => "ha menzionato tutto il canale",
        (Locale::It, "reply") => "ha risposto in una discussione",
        (Locale::It, "message") => "ha scritto",
        (Locale::It, _) => "ti ha inviato un messaggio",
        (Locale::Pl, "mention") => "wspomniał o Tobie",
        (Locale::Pl, "broadcast") => "wspomniał o całym kanale",
        (Locale::Pl, "reply") => "odpowiedział w wątku",
        (Locale::Pl, "message") => "napisał",
        (Locale::Pl, _) => "wysłał Ci wiadomość",
    }
}

/// The body of the test push sent from the preferences.
pub fn push_test_body(locale: Locale) -> &'static str {
    match locale {
        Locale::Fr => "Les notifications arrivent bien sur cet appareil, même Ruchoir fermé.",
        Locale::En => "Notifications reach this device, even with Ruchoir closed.",
        Locale::Es => "Las notificaciones llegan a este dispositivo, incluso con Ruchoir cerrado.",
        Locale::De => {
            "Benachrichtigungen erreichen dieses Gerät, auch wenn Ruchoir geschlossen ist."
        }
        Locale::It => "Le notifiche arrivano su questo dispositivo, anche con Ruchoir chiuso.",
        Locale::Pl => "Powiadomienia docierają na to urządzenie, nawet gdy Ruchoir jest zamknięty.",
    }
}

/// Who did something when their account is gone: the notification outlives its actor.
pub fn someone(locale: Locale) -> &'static str {
    match locale {
        Locale::Fr => "Quelqu'un",
        Locale::En => "Someone",
        Locale::Es => "Alguien",
        Locale::De => "Jemand",
        Locale::It => "Qualcuno",
        Locale::Pl => "Ktoś",
    }
}

/// The unread digest: what is still waiting for someone who has not had Ruchoir open.
///
/// `items` is what the message lists (the caller caps it) and `total` how many are unread in all, so
/// a long backlog is summarised rather than pasted in full.
pub fn unread_digest(
    locale: Locale,
    items: Vec<DigestItem>,
    total: usize,
    link: &str,
    instance: &str,
) -> Email {
    let link = link.to_owned();
    let more = total.saturating_sub(items.len());
    let preheader = items
        .first()
        .map(|item| item.headline.clone())
        .unwrap_or_default();
    let mut content = match locale {
        Locale::Fr => Content {
            subject: if total == 1 {
                "Une notification non lue sur Ruchoir".to_owned()
            } else {
                format!("{total} notifications non lues sur Ruchoir")
            },
            preheader,
            heading: "Pendant votre absence".to_owned(),
            paragraph: "Voici ce qui vous attend sur Ruchoir et que vous n'avez pas encore lu.".to_owned(),
            button: "Ouvrir Ruchoir".to_owned(),
            link,
            note: "Vous recevez cet e-mail parce que ces notifications sont restées non lues alors que Ruchoir n'était ouvert nulle part. Pour ne plus en recevoir, désactivez « Rattrapage par e-mail » dans Préférences > Notifications.".to_owned(),
            items,
        },
        Locale::En => Content {
            subject: if total == 1 {
                "One unread notification on Ruchoir".to_owned()
            } else {
                format!("{total} unread notifications on Ruchoir")
            },
            preheader,
            heading: "While you were away".to_owned(),
            paragraph: "Here is what is waiting for you on Ruchoir and that you have not read yet.".to_owned(),
            button: "Open Ruchoir".to_owned(),
            link,
            note: "You are receiving this email because these notifications stayed unread while Ruchoir was not open anywhere. To stop them, turn off \u{201c}Email catch-up\u{201d} in Preferences > Notifications.".to_owned(),
            items,
        },
        Locale::Es => Content {
            subject: if total == 1 {
                "Una notificación sin leer en Ruchoir".to_owned()
            } else {
                format!("{total} notificaciones sin leer en Ruchoir")
            },
            preheader,
            heading: "Mientras no estabas".to_owned(),
            paragraph: "Esto es lo que te espera en Ruchoir y que aún no has leído.".to_owned(),
            button: "Abrir Ruchoir".to_owned(),
            link,
            note: "Recibes este correo porque estas notificaciones quedaron sin leer mientras Ruchoir no estaba abierto en ningún sitio. Para dejar de recibirlos, desactiva «Resumen por correo» en Preferencias > Notificaciones.".to_owned(),
            items,
        },
        Locale::De => Content {
            subject: if total == 1 {
                "Eine ungelesene Benachrichtigung in Ruchoir".to_owned()
            } else {
                format!("{total} ungelesene Benachrichtigungen in Ruchoir")
            },
            preheader,
            heading: "Während Sie weg waren".to_owned(),
            paragraph: "Das wartet in Ruchoir auf Sie und ist noch ungelesen.".to_owned(),
            button: "Ruchoir öffnen".to_owned(),
            link,
            note: "Sie erhalten diese E-Mail, weil diese Benachrichtigungen ungelesen geblieben sind, während Ruchoir nirgends geöffnet war. Um keine mehr zu erhalten, deaktivieren Sie \u{201e}E-Mail-Zusammenfassung\u{201c} unter Einstellungen > Benachrichtigungen.".to_owned(),
            items,
        },
        Locale::It => Content {
            subject: if total == 1 {
                "Una notifica non letta su Ruchoir".to_owned()
            } else {
                format!("{total} notifiche non lette su Ruchoir")
            },
            preheader,
            heading: "Mentre eri via".to_owned(),
            paragraph: "Ecco cosa ti aspetta su Ruchoir e non hai ancora letto.".to_owned(),
            button: "Apri Ruchoir".to_owned(),
            link,
            note: "Ricevi questa e-mail perché queste notifiche sono rimaste non lette mentre Ruchoir non era aperto da nessuna parte. Per non riceverne più, disattiva «Riepilogo via e-mail» in Preferenze > Notifiche.".to_owned(),
            items,
        },
        Locale::Pl => Content {
            subject: if total == 1 {
                "Jedno nieprzeczytane powiadomienie w Ruchoirze".to_owned()
            } else {
                format!("Nieprzeczytane powiadomienia w Ruchoirze: {total}")
            },
            preheader,
            heading: "Podczas Twojej nieobecności".to_owned(),
            paragraph: "Oto nieprzeczytane wiadomości, które czekają na Ciebie w Ruchoirze.".to_owned(),
            button: "Otwórz Ruchoir".to_owned(),
            link,
            note: "Otrzymujesz tę wiadomość, ponieważ te powiadomienia pozostały nieprzeczytane, gdy Ruchoir nie był nigdzie otwarty. Aby ich nie otrzymywać, wyłącz opcję „Podsumowanie e-mailem” w Preferencje > Powiadomienia.".to_owned(),
            items,
        },
    };
    if more > 0 {
        let tail = match locale {
            Locale::Fr => format!("Et {more} de plus."),
            Locale::En => format!("And {more} more."),
            Locale::Es => format!("Y {more} más."),
            Locale::De => format!("Und {more} weitere."),
            Locale::It => format!("E altre {more}."),
            Locale::Pl => format!("I jeszcze {more}."),
        };
        content.items.push(DigestItem {
            headline: tail,
            excerpt: String::new(),
        });
    }
    render(locale, &content, instance)
}

/// Escape text for HTML: names and topics are somebody's text, never markup.
fn esc(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

// Ruchoir's light palette, from `apps/web/app/tokens.css`. Mail clients read no custom properties,
// so the values are written out.
const CREAM: &str = "#f7f3ed";
const CARD: &str = "#ffffff";
const BORDER: &str = "#e8ded2";
const INK: &str = "#171716";
const BODY: &str = "#4b4945";
const MUTED: &str = "#807a74";
const TERRACOTTA: &str = "#c65d45";
const FONT: &str = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/// Draw a message twice, as HTML and as plain text, from the same content.
fn render(locale: Locale, content: &Content, instance: &str) -> Email {
    let common = common(locale);
    let items_text: String = content
        .items
        .iter()
        .map(|item| {
            if item.excerpt.is_empty() {
                format!("- {}\n", item.headline)
            } else {
                format!("- {}\n  {}\n", item.headline, item.excerpt)
            }
        })
        .collect();
    let paragraph_text = if items_text.is_empty() {
        content.paragraph.clone()
    } else {
        format!("{}\n\n{}", content.paragraph, items_text.trim_end())
    };
    let text = format!(
        "{heading}\n\n{paragraph}\n\n{button} :\n{link}\n\n{note}\n\n-- \nRuchoir. {tagline}\n{sent_by} {instance}",
        heading = content.heading,
        paragraph = paragraph_text,
        button = content.button,
        link = content.link,
        note = content.note,
        tagline = common.tagline,
        sent_by = common.sent_by,
    );
    // The colon before a link is French typography; elsewhere it sits against the word.
    let text = if locale == Locale::Fr {
        text
    } else {
        text.replace(
            &format!("{} :\n", content.button),
            &format!("{}:\n", content.button),
        )
    };

    let lang = locale.as_str();
    let link = esc(&content.link);
    // The digest's lines: one bordered block, each entry a headline over its excerpt.
    let items_html = if content.items.is_empty() {
        String::new()
    } else {
        let rows: String = content
            .items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let rule = if index == 0 {
                    String::new()
                } else {
                    format!("border-top:1px solid {BORDER};")
                };
                let excerpt = if item.excerpt.is_empty() {
                    String::new()
                } else {
                    format!(
                        r#"<br><span style="font-weight:400;color:{BODY};">{}</span>"#,
                        esc(&item.excerpt)
                    )
                };
                format!(
                    r#"<tr><td style="{rule}padding:12px 16px;font-family:{FONT};font-size:14px;line-height:1.5;font-weight:600;color:{INK};">{headline}{excerpt}</td></tr>"#,
                    headline = esc(&item.headline),
                )
            })
            .collect();
        format!(
            r#"<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;border:1px solid {BORDER};border-left:3px solid {TERRACOTTA};border-radius:8px;background:{CREAM};">{rows}</table>"#
        )
    };
    let html = format!(
        r#"<!DOCTYPE html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>{subject}</title>
<style>
@media (max-width: 480px) {{
  .rc-outer {{ padding: 24px 12px !important; }}
  .rc-card {{ padding: 28px 22px 24px 22px !important; }}
  .rc-title {{ font-size: 20px !important; }}
  .rc-button a {{ display: block !important; text-align: center !important; }}
}}
</style>
</head>
<body style="margin:0;padding:0;background:{CREAM};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">{preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{CREAM};">
<tr><td align="center" class="rc-outer" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 4px 24px 4px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;"><img src="cid:{LOGO_CID}" width="36" height="36" alt="" style="display:block;border:0;"></td>
<td style="vertical-align:middle;padding-left:10px;font-family:{FONT};font-size:20px;font-weight:600;letter-spacing:-0.01em;color:{INK};">Ruchoir<span style="color:{TERRACOTTA};">.</span></td>
</tr></table>
</td></tr>
<tr><td class="rc-card" style="background:{CARD};border:1px solid {BORDER};border-top:4px solid {TERRACOTTA};border-radius:12px;padding:36px 36px 32px 36px;">
<h1 class="rc-title" style="margin:0 0 14px 0;font-family:{FONT};font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.01em;color:{INK};">{heading}</h1>
<p style="margin:0 0 28px 0;font-family:{FONT};font-size:15px;line-height:1.6;color:{BODY};">{paragraph}</p>
{items_html}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="rc-button-table"><tr>
<td align="center" bgcolor="{TERRACOTTA}" class="rc-button" style="border-radius:8px;">
<a href="{link}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:{FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">{button}</a>
</td></tr></table>
<p style="margin:28px 0 6px 0;font-family:{FONT};font-size:13px;line-height:1.5;color:{MUTED};">{fallback}</p>
<p style="margin:0 0 24px 0;font-family:{FONT};font-size:13px;line-height:1.5;word-break:break-all;"><a href="{link}" target="_blank" style="color:{TERRACOTTA};text-decoration:underline;">{link}</a></p>
<p style="margin:0;padding-top:20px;border-top:1px solid {BORDER};font-family:{FONT};font-size:13px;line-height:1.55;color:{MUTED};">{note}</p>
</td></tr>
<tr><td align="center" style="padding:24px 16px 0 16px;font-family:{FONT};font-size:12px;line-height:1.6;color:{MUTED};">
<span style="color:{INK};font-weight:600;">Ruchoir.</span> {tagline}<br>
{sent_by} {instance}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
"#,
        subject = esc(&content.subject),
        preheader = esc(&content.preheader),
        heading = esc(&content.heading),
        paragraph = esc(&content.paragraph),
        button = esc(&content.button),
        fallback = esc(common.fallback),
        note = esc(&content.note),
        tagline = esc(common.tagline),
        sent_by = esc(common.sent_by),
        instance = esc(instance),
    );

    Email {
        subject: content.subject.clone(),
        text,
        html,
    }
}

/// Send every message in every language to `to`, with sample content (`mail-preview`).
pub async fn send_previews(config: &crate::config::Config, to: &str) -> Result<(), String> {
    let mailer = super::mailer::Mailer::from_config(config)?;
    if !mailer.can_send() {
        return Err(
            "no SMTP relay configured: set RUCHOIR_SMTP_HOST (a mail catcher in development)"
                .to_owned(),
        );
    }
    let instance = mailer.instance_name();
    let base = mailer.base_url.trim_end_matches('/').to_owned();
    let all = [
        Locale::Fr,
        Locale::En,
        Locale::Es,
        Locale::De,
        Locale::It,
        Locale::Pl,
    ];
    let mut sent = 0;
    for locale in all {
        for email in [
            verification(
                locale,
                &format!("{base}/verify-email?token=preview"),
                24,
                &instance,
            ),
            password_reset(
                locale,
                &format!("{base}/reset-password?token=preview"),
                60,
                &instance,
            ),
            invitation(
                locale,
                "Atelier",
                Some("Camille Roussel"),
                &format!("{base}/invite?token=preview"),
                &instance,
            ),
            unread_digest(
                locale,
                vec![
                    DigestItem {
                        headline: format!(
                            "Camille Roussel {} · #général",
                            notification_verb(locale, "mention")
                        ),
                        excerpt: "@Théo tu peux relire la maquette avant demain ?".to_owned(),
                    },
                    DigestItem {
                        headline: format!("Léa Martin {}", notification_verb(locale, "dm")),
                        excerpt: "Le devis est parti, je te tiens au courant.".to_owned(),
                    },
                ],
                5,
                &format!("{base}/"),
                &instance,
            ),
        ] {
            mailer.send(to, &email).await?;
            sent += 1;
        }
    }
    println!("{sent} messages sent to {to}");
    Ok(())
}

/// A local date as people write it, short: `26/10` in French, `10/26` in English.
pub fn short_date(locale: Locale, date: time::Date) -> String {
    let (day, month) = (date.day(), u8::from(date.month()));
    match locale {
        Locale::En => format!("{month}/{day}"),
        Locale::De | Locale::Pl => format!("{day:02}.{month:02}."),
        Locale::Fr | Locale::Es | Locale::It => format!("{day:02}/{month:02}"),
    }
}

/// How soon a reminded event starts, as a reminder's first words: "In 10 min", "Tomorrow".
///
/// `minutes` is how long until it starts (a timed event); `day` tells an all-day event happening
/// today from one happening tomorrow.
pub fn reminder_lead(locale: Locale, minutes: i64, day: ReminderDay) -> String {
    let hours = (minutes + 30) / 60;
    match (locale, day) {
        (Locale::Fr, ReminderDay::Today) => "Aujourd'hui".to_owned(),
        (Locale::Fr, ReminderDay::Tomorrow) => "Demain".to_owned(),
        (Locale::En, ReminderDay::Today) => "Today".to_owned(),
        (Locale::En, ReminderDay::Tomorrow) => "Tomorrow".to_owned(),
        (Locale::Es, ReminderDay::Today) => "Hoy".to_owned(),
        (Locale::Es, ReminderDay::Tomorrow) => "Mañana".to_owned(),
        (Locale::De, ReminderDay::Today) => "Heute".to_owned(),
        (Locale::De, ReminderDay::Tomorrow) => "Morgen".to_owned(),
        (Locale::It, ReminderDay::Today) => "Oggi".to_owned(),
        (Locale::It, ReminderDay::Tomorrow) => "Domani".to_owned(),
        (Locale::Pl, ReminderDay::Today) => "Dziś".to_owned(),
        (Locale::Pl, ReminderDay::Tomorrow) => "Jutro".to_owned(),
        (_, ReminderDay::Timed) if minutes >= 1440 => {
            reminder_lead(locale, 0, ReminderDay::Tomorrow)
        }
        (Locale::Fr, ReminderDay::Timed) if minutes <= 0 => "Maintenant".to_owned(),
        (Locale::Fr, ReminderDay::Timed) if minutes < 60 => format!("Dans {minutes}\u{a0}min"),
        (Locale::Fr, ReminderDay::Timed) => format!("Dans {hours}\u{a0}h"),
        (Locale::En, ReminderDay::Timed) if minutes <= 0 => "Now".to_owned(),
        (Locale::En, ReminderDay::Timed) if minutes < 60 => format!("In {minutes} min"),
        (Locale::En, ReminderDay::Timed) => format!("In {hours} h"),
        (Locale::Es, ReminderDay::Timed) if minutes <= 0 => "Ahora".to_owned(),
        (Locale::Es, ReminderDay::Timed) if minutes < 60 => format!("En {minutes} min"),
        (Locale::Es, ReminderDay::Timed) => format!("En {hours} h"),
        (Locale::De, ReminderDay::Timed) if minutes <= 0 => "Jetzt".to_owned(),
        (Locale::De, ReminderDay::Timed) if minutes < 60 => format!("In {minutes} Min."),
        (Locale::De, ReminderDay::Timed) => format!("In {hours} Std."),
        (Locale::It, ReminderDay::Timed) if minutes <= 0 => "Ora".to_owned(),
        (Locale::It, ReminderDay::Timed) if minutes < 60 => format!("Tra {minutes} min"),
        (Locale::It, ReminderDay::Timed) => format!("Tra {hours} h"),
        (Locale::Pl, ReminderDay::Timed) if minutes <= 0 => "Teraz".to_owned(),
        (Locale::Pl, ReminderDay::Timed) if minutes < 60 => format!("Za {minutes} min"),
        (Locale::Pl, ReminderDay::Timed) => format!("Za {hours} godz."),
    }
}

/// What kind of moment a reminder announces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReminderDay {
    Timed,
    Today,
    Tomorrow,
}

/// A reminder's title line: "Dans 10 min : Point équipe", with the French space before the colon.
pub fn reminder_title(locale: Locale, lead: &str, title: &str) -> String {
    match locale {
        Locale::Fr => format!("{lead}\u{a0}: {title}"),
        _ => format!("{lead}: {title}"),
    }
}

/// A calendar reminder by mail, for someone who has no Ruchoir open.
///
/// `when` is the occurrence's local date and time as the reader writes them, `lead` how soon it
/// is ("Dans 10 min").
pub fn calendar_reminder(
    locale: Locale,
    lead: &str,
    title: &str,
    when: &str,
    location: Option<&str>,
    link: &str,
    instance: &str,
) -> Email {
    let link = link.to_owned();
    let place = location.map(|l| format!(" · {l}")).unwrap_or_default();
    let subject = reminder_title(locale, lead, title);
    let content = match locale {
        Locale::Fr => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Ouvrir le calendrier".to_owned(),
            link,
            note: "Vous recevez cet e-mail parce que vous avez un rappel pour cet événement et que Ruchoir n'était ouvert nulle part. Pour ne plus en recevoir, désactivez «\u{a0}Rappels d'agenda\u{a0}» par e-mail dans Préférences > Notifications.".to_owned(),
            items: Vec::new(),
        },
        Locale::En => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Open the calendar".to_owned(),
            link,
            note: "You are receiving this email because you have a reminder for this event and Ruchoir was not open anywhere. To stop them, turn off \u{201c}Calendar reminders\u{201d} by email in Preferences > Notifications.".to_owned(),
            items: Vec::new(),
        },
        Locale::Es => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Abrir el calendario".to_owned(),
            link,
            note: "Recibes este correo porque tienes un recordatorio para este evento y Ruchoir no estaba abierto en ningún sitio. Para dejar de recibirlos, desactiva «Recordatorios de agenda» por correo en Preferencias > Notificaciones.".to_owned(),
            items: Vec::new(),
        },
        Locale::De => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Kalender öffnen".to_owned(),
            link,
            note: "Sie erhalten diese E-Mail, weil Sie eine Erinnerung für diesen Termin haben und Ruchoir nirgends geöffnet war. Um keine mehr zu erhalten, deaktivieren Sie \u{201e}Kalendererinnerungen\u{201c} per E-Mail unter Einstellungen > Benachrichtigungen.".to_owned(),
            items: Vec::new(),
        },
        Locale::It => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Apri il calendario".to_owned(),
            link,
            note: "Ricevi questa e-mail perché hai un promemoria per questo evento e Ruchoir non era aperto da nessuna parte. Per non riceverne più, disattiva «Promemoria del calendario» via e-mail in Preferenze > Notifiche.".to_owned(),
            items: Vec::new(),
        },
        Locale::Pl => Content {
            subject,
            preheader: format!("{when}{place}"),
            heading: title.to_owned(),
            paragraph: format!("{lead}, {when}{place}."),
            button: "Otwórz kalendarz".to_owned(),
            link,
            note: "Otrzymujesz tę wiadomość, ponieważ masz przypomnienie o tym wydarzeniu, a Ruchoir nie był nigdzie otwarty. Aby ich nie otrzymywać, wyłącz e-mailowe „Przypomnienia z kalendarza” w Preferencje > Powiadomienia.".to_owned(),
            items: Vec::new(),
        },
    };
    render(locale, &content, instance)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Locale; 6] = [
        Locale::Fr,
        Locale::En,
        Locale::Es,
        Locale::De,
        Locale::It,
        Locale::Pl,
    ];

    #[test]
    fn parses_a_tag_with_a_region() {
        assert_eq!(Locale::parse(Some("de-AT")), Locale::De);
        assert_eq!(Locale::parse(Some("pl_PL")), Locale::Pl);
    }

    #[test]
    fn falls_back_to_the_source_language() {
        assert_eq!(Locale::parse(None), Locale::Fr);
        assert_eq!(Locale::parse(Some("")), Locale::Fr);
        assert_eq!(Locale::parse(Some("ja")), Locale::Fr);
    }

    #[test]
    fn every_message_carries_its_link_in_both_bodies() {
        for locale in ALL {
            for email in [
                verification(locale, "https://x.test/v?token=LINK", 24, "x.test"),
                password_reset(locale, "https://x.test/r?token=LINK", 30, "x.test"),
                invitation(
                    locale,
                    "SPACE",
                    Some("Camille"),
                    "https://x.test/i?token=LINK",
                    "x.test",
                ),
            ] {
                assert!(email.text.contains("token=LINK"), "{locale}");
                assert!(email.html.contains("token=LINK"), "{locale}");
                assert!(email.html.contains(&format!("cid:{LOGO_CID}")), "{locale}");
                assert!(email
                    .html
                    .contains(&format!("lang=\"{}\"", locale.as_str())));
            }
            let invite = invitation(locale, "SPACE", Some("Camille"), "L", "x.test");
            assert!(invite.subject.contains("SPACE"));
            assert!(invite.text.contains("Camille"));
        }
    }

    #[test]
    fn the_digest_lists_what_is_waiting_and_counts_the_rest() {
        for locale in ALL {
            let email = unread_digest(
                locale,
                vec![DigestItem {
                    headline: "HEADLINE".to_owned(),
                    excerpt: "EXCERPT".to_owned(),
                }],
                4,
                "https://x.test/",
                "x.test",
            );
            for body in [&email.text, &email.html] {
                assert!(body.contains("HEADLINE"), "{locale}");
                assert!(body.contains("EXCERPT"), "{locale}");
                assert!(
                    body.contains('3'),
                    "{locale}: the three not listed are counted"
                );
            }
            assert!(email.subject.contains('4'), "{locale}");
        }
        let one = unread_digest(Locale::Fr, Vec::new(), 1, "L", "x.test");
        assert!(!one.subject.contains('1'));
    }

    #[test]
    fn a_digest_line_is_never_markup() {
        let email = unread_digest(
            Locale::En,
            vec![DigestItem {
                headline: "<b>Eve</b>".to_owned(),
                excerpt: "<img src=x onerror=alert(1)>".to_owned(),
            }],
            1,
            "L",
            "x.test",
        );
        assert!(!email.html.contains("<img src=x"));
        assert!(email.html.contains("&lt;img src=x"));
        assert!(email.html.contains("&lt;b&gt;Eve&lt;/b&gt;"));
    }

    #[test]
    fn what_people_typed_is_never_markup() {
        let email = invitation(
            Locale::En,
            "<script>alert(1)</script>",
            Some("Eve & \"Co\""),
            "https://x.test/i?a=1&b=2",
            "x.test",
        );
        assert!(!email.html.contains("<script>"));
        assert!(email.html.contains("&lt;script&gt;"));
        assert!(email.html.contains("Eve &amp; &quot;Co&quot;"));
        assert!(email.html.contains("a=1&amp;b=2"));
    }

    #[test]
    fn a_reminder_says_how_soon_in_the_readers_language() {
        assert_eq!(
            reminder_lead(Locale::Fr, 10, ReminderDay::Timed),
            "Dans 10\u{a0}min"
        );
        assert_eq!(
            reminder_lead(Locale::Fr, 0, ReminderDay::Timed),
            "Maintenant"
        );
        assert_eq!(
            reminder_lead(Locale::Fr, 60, ReminderDay::Timed),
            "Dans 1\u{a0}h"
        );
        assert_eq!(
            reminder_lead(Locale::Fr, 1440, ReminderDay::Timed),
            "Demain"
        );
        assert_eq!(
            reminder_lead(Locale::En, 30, ReminderDay::Timed),
            "In 30 min"
        );
        assert_eq!(
            reminder_lead(Locale::Pl, 120, ReminderDay::Timed),
            "Za 2 godz."
        );
        assert_eq!(reminder_lead(Locale::De, 0, ReminderDay::Today), "Heute");
        assert_eq!(
            reminder_title(Locale::Fr, "Dans 10\u{a0}min", "Point"),
            "Dans 10\u{a0}min\u{a0}: Point"
        );
        let date = time::Date::from_calendar_date(2026, time::Month::October, 7).unwrap();
        assert_eq!(short_date(Locale::Fr, date), "07/10");
        assert_eq!(short_date(Locale::En, date), "10/7");
        assert_eq!(short_date(Locale::De, date), "07.10.");
        let mail = calendar_reminder(
            Locale::Fr,
            "Dans 10\u{a0}min",
            "Point équipe",
            "07/10 09:00",
            Some("Salle Ouest"),
            "https://ruchoir.example",
            "ruchoir.example",
        );
        assert_eq!(mail.subject, "Dans 10\u{a0}min\u{a0}: Point équipe");
        assert!(mail.text.contains("07/10 09:00 · Salle Ouest"));
    }
}
