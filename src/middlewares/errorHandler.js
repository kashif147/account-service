export default function errorHandler(err, req, res, next) {
  const status = err.status || 400;
  res.status(status).json({ error: err.message || "Unexpected error" });
}
