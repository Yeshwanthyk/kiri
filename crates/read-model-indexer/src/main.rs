use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::{self, Read};

const CONTRACT_VERSION: u8 = 1;
const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadModelIndexInput {
    version: u8,
    candidates: Vec<ReadModelCandidate>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadModelCandidate {
    kind: String,
    entity_id: String,
    payload: Value,
    updated_at: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReadModelIndexOutput {
    version: u8,
    entries: Vec<ReadModelEntry>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ReadModelEntry {
    kind: String,
    entity_id: String,
    revision: String,
    payload: Value,
    updated_at: String,
}

fn main() {
    match run() {
        Ok(output) => println!(
            "{}",
            serde_json::to_string(&output).expect("read model output should serialize")
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<ReadModelIndexOutput, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read read-model input: {error}"))?;
    index_read_model_input(&input)
}

fn index_read_model_input(input: &str) -> Result<ReadModelIndexOutput, String> {
    let parsed: ReadModelIndexInput = serde_json::from_str(input)
        .map_err(|error| format!("failed to parse read-model input: {error}"))?;
    if parsed.version != CONTRACT_VERSION {
        return Err(format!(
            "unsupported read-model contract version: {}",
            parsed.version
        ));
    }

    let entries = parsed
        .candidates
        .into_iter()
        .map(|candidate| {
            let revision = revision_for_candidate(&candidate);
            ReadModelEntry {
                kind: candidate.kind,
                entity_id: candidate.entity_id,
                revision,
                payload: candidate.payload,
                updated_at: candidate.updated_at,
            }
        })
        .collect();
    Ok(ReadModelIndexOutput {
        version: CONTRACT_VERSION,
        entries,
    })
}

fn revision_for_candidate(candidate: &ReadModelCandidate) -> String {
    let mut hash = FNV_OFFSET_BASIS;
    update_hash(&mut hash, candidate.kind.as_bytes());
    update_hash(&mut hash, b"\0");
    update_hash(&mut hash, candidate.entity_id.as_bytes());
    update_hash(&mut hash, b"\0");
    update_hash(&mut hash, stable_json(&candidate.payload).as_bytes());
    format!("{hash:016x}")
}

fn update_hash(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}

fn stable_json(value: &Value) -> String {
    match value {
        Value::Object(object) => stable_object_json(object),
        Value::Array(items) => {
            let values: Vec<_> = items.iter().map(stable_json).collect();
            format!("[{}]", values.join(","))
        }
        _ => serde_json::to_string(value).expect("json value should serialize"),
    }
}

fn stable_object_json(object: &Map<String, Value>) -> String {
    let mut keys: Vec<_> = object.keys().collect();
    keys.sort();
    let fields: Vec<_> = keys
        .into_iter()
        .map(|key| {
            let key_json = serde_json::to_string(key).expect("json key should serialize");
            let value_json = stable_json(&object[key]);
            format!("{key_json}:{value_json}")
        })
        .collect();
    format!("{{{}}}", fields.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn indexes_candidates_with_stable_revisions() {
        let output = index_read_model_input(
            &json!({
                "version": 1,
                "candidates": [{
                    "kind": "agent.timeline.summary",
                    "entityId": "agent-1",
                    "payload": {
                        "messageCount": 2,
                        "agentId": "agent-1"
                    },
                    "updatedAt": "2026-01-01T00:00:00.000Z"
                }]
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(output.entries.len(), 1);
        assert_eq!(output.entries[0].kind, "agent.timeline.summary");
        assert_eq!(output.entries[0].entity_id, "agent-1");
        assert_eq!(output.entries[0].revision.len(), 16);
    }

    #[test]
    fn sorts_nested_payload_keys_before_hashing() {
        let left = ReadModelCandidate {
            kind: "workspace.summary".to_string(),
            entity_id: "workspace".to_string(),
            payload: json!({ "b": 1, "a": { "d": 2, "c": 3 } }),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        };
        let right = ReadModelCandidate {
            kind: "workspace.summary".to_string(),
            entity_id: "workspace".to_string(),
            payload: json!({ "a": { "c": 3, "d": 2 }, "b": 1 }),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        };

        assert_eq!(
            revision_for_candidate(&left),
            revision_for_candidate(&right)
        );
    }

    #[test]
    fn revision_matches_typescript_fallback_fixture() {
        let candidate = ReadModelCandidate {
            kind: "agent.timeline.summary".to_string(),
            entity_id: "agent-1".to_string(),
            payload: json!({
                "agentId": "agent-1",
                "threadId": "thread-1",
                "preview": "Hello",
                "messageCount": 2,
                "eventCount": 1,
                "taskCount": 0,
                "latestTimelineAt": "2026-01-01T00:00:02.000Z"
            }),
            updated_at: "2026-01-01T00:00:02.000Z".to_string(),
        };

        assert_eq!(revision_for_candidate(&candidate), "9dde7623837b160b");
    }

    #[test]
    fn rejects_unknown_contract_versions() {
        let error = index_read_model_input(r#"{"version":2,"candidates":[]}"#).unwrap_err();

        assert!(error.contains("unsupported read-model contract version: 2"));
    }
}
