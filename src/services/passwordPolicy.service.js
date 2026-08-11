export const MINIMUM_PASSWORD_LENGTH = 8

export const validatePassword = (password) => {
  if (typeof password !== "string" || password.length === 0) {
    return {
      valid: false,
      errorCode: "PASSWORD_REQUIRED",
      message: "Password is required.",
    }
  }

  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return {
      valid: false,
      errorCode: "PASSWORD_TOO_SHORT",
      message: `Password must be at least ${MINIMUM_PASSWORD_LENGTH} characters long.`,
    }
  }

  return { valid: true, errorCode: null, message: null }
}

export const assertValidPassword = (password) => {
  const result = validatePassword(password)
  if (!result.valid) {
    throw Object.assign(new Error(result.message), {
      errorCode: result.errorCode,
      statusCode: 400,
    })
  }
  return password
}

