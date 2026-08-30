use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

const EXPIRE_AFTER_HOURS: i64 = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<DateTime<Utc>>,
    pub duration_minutes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedObservation {
    pub schema_version: u8,
    pub account_id: String,
    pub source_revision: u64,
    pub observed_at: DateTime<Utc>,
    pub windows: Vec<UsageWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub status: String,
    pub observed_at: Option<DateTime<Utc>>,
    pub windows: Vec<UsageWindow>,
    pub detail: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DashboardState {
    pub generated_at: DateTime<Utc>,
    pub accounts: Vec<AccountSnapshot>,
}

impl AccountSnapshot {
    pub fn unavailable(id: &str, provider: &str, label: &str, detail: &str) -> Self {
        Self {
            id: id.to_owned(),
            provider: provider.to_owned(),
            label: label.to_owned(),
            status: "unavailable".to_owned(),
            observed_at: None,
            windows: vec![],
            detail: Some(detail.to_owned()),
            error_code: None,
        }
    }

    pub fn error(id: &str, provider: &str, label: &str, code: &str, detail: &str) -> Self {
        Self {
            id: id.to_owned(),
            provider: provider.to_owned(),
            label: label.to_owned(),
            status: "error".to_owned(),
            observed_at: None,
            windows: vec![],
            detail: Some(detail.to_owned()),
            error_code: Some(code.to_owned()),
        }
    }

    pub fn from_observation(
        observation: SanitizedObservation,
        provider: &str,
        label: &str,
        now: DateTime<Utc>,
        stale_after_minutes: i64,
    ) -> Self {
        let age = now.signed_duration_since(observation.observed_at);
        let (status, detail, error_code) = if age < Duration::minutes(-5) {
            (
                "stale",
                Some("The device clock appears to be out of sync".to_owned()),
                Some("clock_skew".to_owned()),
            )
        } else if age > Duration::hours(EXPIRE_AFTER_HOURS) {
            (
                "unavailable",
                Some("The observed data has expired".to_owned()),
                Some("observation_expired".to_owned()),
            )
        } else if age > Duration::minutes(stale_after_minutes) {
            (
                "stale",
                Some("Showing the last value received".to_owned()),
                Some("observation_stale".to_owned()),
            )
        } else {
            ("live", None, None)
        };

        Self {
            id: observation.account_id,
            provider: provider.to_owned(),
            label: label.to_owned(),
            status: status.to_owned(),
            observed_at: Some(observation.observed_at),
            windows: if status == "unavailable" {
                vec![]
            } else {
                observation.windows
            },
            detail,
            error_code,
        }
    }

    pub fn mark_stale_at(mut self, code: &str, detail: &str, now: DateTime<Utc>) -> Self {
        if self.observed_at.is_some_and(|observed_at| {
            now.signed_duration_since(observed_at) > Duration::hours(EXPIRE_AFTER_HOURS)
        }) {
            self.status = "unavailable".to_owned();
            self.windows.clear();
            self.error_code = Some("snapshot_expired".to_owned());
            self.detail = Some("The previous value has expired".to_owned());
            return self;
        }
        if !self.windows.is_empty() {
            self.status = "stale".to_owned();
            self.error_code = Some(code.to_owned());
            self.detail = Some(detail.to_owned());
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn observation(account_id: &str, observed_at: DateTime<Utc>) -> SanitizedObservation {
        SanitizedObservation {
            schema_version: 4,
            account_id: account_id.to_owned(),
            source_revision: 1,
            observed_at,
            windows: vec![UsageWindow {
                id: "five-hour".to_owned(),
                label: "5 hours".to_owned(),
                used_percent: 25.0,
                resets_at: None,
                duration_minutes: Some(300),
            }],
        }
    }

    #[test]
    fn dynamic_account_label_is_applied_at_render_time() {
        let now = Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap();
        let snapshot = AccountSnapshot::from_observation(
            observation("my-claude", now),
            "anthropic",
            "Client account",
            now,
            10,
        );
        assert_eq!(snapshot.id, "my-claude");
        assert_eq!(snapshot.label, "Client account");
    }

    #[test]
    fn observation_becomes_stale_after_configured_threshold() {
        let now = Utc.with_ymd_and_hms(2026, 8, 15, 10, 20, 0).unwrap();
        let earlier = Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap();
        let snapshot = AccountSnapshot::from_observation(
            observation("claude-work", earlier),
            "anthropic",
            "Claude Work",
            now,
            15,
        );
        assert_eq!(snapshot.status, "stale");
        assert_eq!(snapshot.error_code.as_deref(), Some("observation_stale"));
        assert_eq!(snapshot.windows.len(), 1);
    }

    #[test]
    fn expired_observation_does_not_display_old_values() {
        let now = Utc.with_ymd_and_hms(2026, 8, 16, 11, 0, 0).unwrap();
        let earlier = Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap();
        let snapshot = AccountSnapshot::from_observation(
            observation("claude-personal", earlier),
            "anthropic",
            "Claude Personal",
            now,
            10,
        );
        assert_eq!(snapshot.status, "unavailable");
        assert!(snapshot.windows.is_empty());
    }

    #[test]
    fn stale_snapshot_expires_after_twenty_four_hours() {
        let observed_at = Utc.with_ymd_and_hms(2026, 8, 15, 10, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 8, 16, 11, 0, 0).unwrap();
        let snapshot = AccountSnapshot::from_observation(
            observation("codex", observed_at),
            "openai",
            "Codex",
            observed_at,
            10,
        )
        .mark_stale_at("source_timeout", "timeout", now);
        assert_eq!(snapshot.status, "unavailable");
        assert_eq!(snapshot.error_code.as_deref(), Some("snapshot_expired"));
        assert!(snapshot.windows.is_empty());
    }
}
