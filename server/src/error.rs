use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

/// A refusal the client can act on: HTTP status, a stable code and a Korean message for the page.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: &'static str,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub const fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self { status, code, message }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"code": self.code, "message": self.message}))).into_response()
    }
}

const CLASHED: ApiError = conflict("conflict", "다른 요청과 겹쳐 처리하지 못했습니다. 다시 시도해 주세요.");
const REFUSED_VALUE: ApiError = bad("invalid_value", "저장할 수 없는 값입니다.");

impl From<sqlx::Error> for ApiError {
    /// A constraint the request ran into, or a value the database cannot take (SQLSTATE class 22), is the request's
    /// problem; anything else is the database's.
    fn from(error: sqlx::Error) -> Self {
        if let sqlx::Error::Database(database) = &error {
            use sqlx::error::ErrorKind;
            let refusal = match database.kind() {
                ErrorKind::UniqueViolation | ErrorKind::ForeignKeyViolation => Some(CLASHED),
                ErrorKind::NotNullViolation | ErrorKind::CheckViolation => Some(REFUSED_VALUE),
                _ if database.code().is_some_and(|code| code.starts_with("22")) => Some(REFUSED_VALUE),
                _ => None,
            };
            if let Some(refusal) = refusal {
                tracing::warn!(%error, "Database refused a request");
                return refusal;
            }
        }
        tracing::error!(%error, "Database request failed");
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "database", "저장 서버 요청에 실패했습니다.")
    }
}

pub const fn bad(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, code, message)
}

pub const fn not_found(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, code, message)
}

pub const fn forbidden(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, code, message)
}

pub const fn conflict(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, code, message)
}

pub const LOGIN_REQUIRED: ApiError = ApiError::new(StatusCode::UNAUTHORIZED, "login_required", "로그인이 필요합니다.");

pub fn internal(error: impl std::fmt::Display) -> ApiError {
    tracing::error!(%error, "Request failed");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", "잠시 후 다시 시도해 주세요.")
}
