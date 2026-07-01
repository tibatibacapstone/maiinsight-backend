export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message)
    this.name = "HttpError"
    this.statusCode = statusCode
    this.details = details
  }
}

export const badRequest = (message, details = undefined) =>
  new HttpError(400, message, details)

