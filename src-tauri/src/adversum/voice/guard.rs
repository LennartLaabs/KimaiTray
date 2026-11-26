//! Keeps invented text out. Given silence or noise, Whisper does not return
//! nothing: it writes what often follows silence in its training data
//! ("Danke.", "Untertitel …") or repeats the vocabulary it was primed with.

/// Above this probability of "no speech", a transcript is not trusted.
const NO_SPEECH_LIMIT: f32 = 0.6;

/// Phrases Whisper writes for audio without speech. None of them means
/// anything to a time tracker, so they are dropped whatever the audio was.
const FILLER: [&str; 12] = [
    "danke",
    "danke schoen",
    "dankeschoen",
    "vielen dank",
    "vielen dank fuers zuschauen",
    "vielen dank fuer ihre aufmerksamkeit",
    "bis zum naechsten mal",
    "tschuess",
    "das wars",
    "musik",
    "applaus",
    "amen",
];
const FILLER_STARTS: [&str; 3] = ["untertitel", "copyright", "swr"];
/// The headings of the vocabulary (`src/adversum/voice/vocabulary.ts`). A
/// transcript that begins like the vocabulary is the vocabulary coming back.
const VOCABULARY_HEADINGS: [&str; 5] = ["notizen", "projekte", "taetigkeiten", "kuerzel", "kunden"];

/// Lowercase letters and digits with single spaces; umlauts written out.
pub(crate) fn fold(text: &str) -> String {
    let mut folded = String::with_capacity(text.len());
    for character in text.chars().flat_map(char::to_lowercase) {
        match character {
            'ä' => folded.push_str("ae"),
            'ö' => folded.push_str("oe"),
            'ü' => folded.push_str("ue"),
            'ß' => folded.push_str("ss"),
            other if other.is_alphanumeric() => folded.push(other),
            _ => folded.push(' '),
        }
    }
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether a transcript is what someone said, as far as can be told.
pub(crate) fn is_plausible(text: &str, no_speech_probability: f32) -> bool {
    let folded = fold(text);
    if folded.is_empty() || no_speech_probability > NO_SPEECH_LIMIT {
        return false;
    }
    if FILLER.contains(&folded.as_str())
        || FILLER_STARTS.iter().any(|start| folded.starts_with(start))
    {
        return false;
    }
    let first = folded.split(' ').next().unwrap_or_default();
    // "Projekte." or "Projekte, Marketing Retainer, …": the text has the
    // vocabulary's heading where a sentence would have its first word, and
    // right after it a separator, not a continuation of a sentence.
    let after_heading = text
        .trim_start()
        .trim_start_matches(char::is_alphanumeric)
        .chars()
        .next();
    !VOCABULARY_HEADINGS.contains(&first) || matches!(after_heading, Some(' '))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_folded_for_comparison() {
        assert_eq!(
            fold("  Vielen Dank fürs Zuschauen! "),
            "vielen dank fuers zuschauen"
        );
        assert_eq!(fold("Tschüß."), "tschuess");
        assert_eq!(fold("…"), "");
    }

    #[test]
    fn real_sentences_pass() {
        for text in [
            "DUSW Projektmanagement, Gigi Call seit 10 Uhr.",
            "Stop.",
            "Notiz, Angebot nachfassen.",
            "Projekte planen für DUSW",
            "Kunden anrufen wegen Angebot",
            "Tätigkeiten planen",
            "Danke an Gigi schreiben",
        ] {
            assert!(is_plausible(text, 0.1), "{text}");
        }
    }

    #[test]
    fn what_whisper_invents_for_silence_is_dropped() {
        for text in [
            "Danke.",
            " Vielen Dank.",
            "Vielen Dank fürs Zuschauen!",
            "Untertitel der Amara.org-Community",
            "Untertitelung des ZDF, 2020",
            "Bis zum nächsten Mal.",
            "Tschüss!",
            "",
            " . ",
        ] {
            assert!(!is_plausible(text, 0.1), "{text}");
        }
    }

    #[test]
    fn the_vocabulary_coming_back_is_dropped() {
        for text in [
            "Projekte.",
            "Projekte, Marketing Retainer, Website Relaunch, Imagefilm.",
            "Kunden: DUSW, SolarTech NRW.",
            "Tätigkeiten.",
            "Kürzel",
        ] {
            assert!(!is_plausible(text, 0.1), "{text}");
        }
    }

    #[test]
    fn a_likely_silence_is_not_trusted_whatever_it_says() {
        assert!(!is_plausible("DUSW Projektmanagement", 0.9));
        assert!(is_plausible("DUSW Projektmanagement", 0.6));
    }
}
