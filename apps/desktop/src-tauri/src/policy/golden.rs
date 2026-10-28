use super::*;

/// Runs the original TypeScript/Zod test inputs through the Rust policy engine.
/// The fixture generator executes the reference assertions before recording any
/// accepted normalization or rejected error code, so the oracle cannot silently
/// drift to satisfy this test.
#[test]
fn matches_all_zod_reference_policy_cases() {
    let fixtures: Value = serde_json::from_str(include_str!("golden.json")).unwrap();
    let cases = fixtures["cases"].as_array().unwrap();
    assert!(cases.len() >= 159);
    assert_eq!(fixtures["testsRun"], 47);
    let mut differences = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let action = case["actionId"].as_str().unwrap();
        let result = if case["api"] == "authorizeAction" {
            let connection =
                &fixtures["connections"][case["connection"].as_u64().unwrap() as usize];
            authorize(
                connection,
                action,
                &case["parameters"],
                case["maximumRiskLevel"].as_str().unwrap(),
                case["contractVersion"].as_str().unwrap(),
            )
            .map(|parameters| {
                json!({
                    "actionId": action,
                    "parameters": parameters,
                    "riskLevel": action_contract(action).unwrap()["riskLevel"]
                })
            })
        } else {
            assert_eq!(case["api"], "validateDiagnosticTemplateAction");
            validate_template_action(action, &case["parameters"])
        };
        let actual = match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"errorCode":error.code}),
        };
        if actual != case["result"] {
            let detail = format!(
                "case {index} {action}: {} / {}\nexpected={}\nactual={}",
                case["suite"], case["test"], case["result"], actual
            );
            differences.push(detail.chars().take(2000).collect::<String>());
        }
    }
    assert!(
        differences.is_empty(),
        "{} of {} policy oracle cases differ:\n{}",
        differences.len(),
        cases.len(),
        differences.join("\n")
    );
}
