/** Wrap async route handlers so thrown errors hit the error middleware. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/** 404 handler. */
export function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
}

/** Central error handler. */
export function errorHandler(err, req, res, _next) {
  console.error("[ERROR]", req.method, req.path, "\n", err.stack || err.message);

  // Malformed ObjectIds and bad payloads are client errors, not crashes
  let status = err.status || 500;
  if (err.name === "CastError" || err.name === "ValidationError") status = 400;
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large")
    status = 400;

  // Never leak internal error details to clients in production
  const message =
    status >= 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Internal server error";

  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === "development" ? { stack: err.stack } : {}),
  });
}

export default { asyncHandler, notFound, errorHandler };
