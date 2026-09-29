use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE},
};
use mogaesup_server::{
    config::FactoryToken,
    factory::{hmac_key, operator_token},
};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

/// Loads the character server's own `auth.py` (backend/src) and runs each token through the checks its API applies.
const CHECK: &str = r#"
import json, os, sys
sys.path.insert(0, os.environ["AUTH_PY_DIR"])
import auth
results = []
for case in json.load(sys.stdin):
    os.environ["JWT_SECRET"] = case["secret"]
    key = auth._resolve_secret().hex()
    try:
        claims = auth._decode_claims(case["token"])
    except auth.HTTPException as error:
        results.append({"key": key, "rejected": error.detail})
        continue
    roles = auth._extract_roles(claims)
    results.append({"key": key, "userId": auth._extract_user_id(claims), "level": auth._compute_level(roles)})
json.dump(results, sys.stdout)
"#;

/// `name==version` as the character server's uv.lock pins it.
fn locked(lock: &str, name: &str) -> String {
    let entry = lock.split("[[package]]").find(|entry| entry.contains(&format!("\nname = \"{name}\"\n"))).unwrap();
    let version = entry.lines().find_map(|line| line.strip_prefix("version = \"")).unwrap().trim_end_matches('"');
    format!("{name}=={version}")
}

fn token(secret: &str) -> FactoryToken {
    FactoryToken { key: hmac_key(secret), issuer: "mogaesup".into(), audience: "mogaesup-client".into(), owner_id: 7 }
}

#[test]
fn 운영자_토큰은_캐릭터_서버의_auth_py가_받아들인다() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let auth_dir = root.join("backend/src");
    if !auth_dir.join("auth.py").is_file() || Command::new("uv").arg("--version").output().is_err() {
        eprintln!("건너뜀: backend/src/auth.py 또는 uv가 없습니다");
        return;
    }
    // Python's lenient base64 changed in 3.13, so the check runs on the interpreter and packages the server pins.
    let python = std::fs::read_to_string(root.join(".python-version")).unwrap().trim().to_owned();
    let lock = std::fs::read_to_string(root.join("uv.lock")).unwrap().replace("\r\n", "\n");
    let raw: Vec<u8> = (0..64).collect();
    let dashes: Vec<u8> = [0xfb, 0xff, 0xbf].repeat(16);
    let secrets = [
        "mogaesup-operator-passphrase-0123456789-abcdef".to_owned(),
        STANDARD.encode(&raw),
        STANDARD.encode(&raw[..40]),
        format!("{}\n{}", &STANDARD.encode(&raw)[..64], &STANDARD.encode(&raw)[64..]),
        format!("{}tail", STANDARD.encode(&raw[..34])),
        URL_SAFE.encode(&dashes),
    ];
    let mut cases: Vec<Value> = secrets
        .iter()
        .map(|secret| json!({"secret": secret, "token": operator_token(&token(secret), "operator")}))
        .collect();
    cases.push(json!({"secret": secrets[1], "token": operator_token(&token(&secrets[0]), "operator")}));

    let mut child = Command::new("uv")
        .args(["run", "--no-project", "--quiet", "--python", &python])
        .args(["--with", &locked(&lock, "pyjwt"), "--with", &locked(&lock, "fastapi"), "python", "-c", CHECK])
        .current_dir(std::env::temp_dir())
        .env("AUTH_PY_DIR", &auth_dir)
        .env("JWT_ISSUER", "mogaesup")
        .env("JWT_AUDIENCE", "mogaesup-client")
        .env_remove("JWT_MIN_SECRET_LENGTH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(Value::Array(cases).to_string().as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let results: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();

    for (secret, result) in secrets.iter().zip(&results) {
        assert_eq!(result["key"], hex::encode(hmac_key(secret)), "{secret:?}");
        assert_eq!(result["userId"], 7, "{secret:?}: {result}");
        assert_eq!(result["level"], 2, "{secret:?}: {result}");
    }
    assert!(results[secrets.len()]["rejected"].as_str().is_some_and(|detail| detail.contains("Invalid JWT")));
}
