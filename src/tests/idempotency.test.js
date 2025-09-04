import {
  clearIdempotencyCache,
  getIdempotencyCacheSize,
} from "../middlewares/idempotency.js";

// Test idempotency functionality
export function testIdempotency() {
  console.log("=== Idempotency Test ===");

  // Clear cache before testing
  clearIdempotencyCache();
  console.log("Cache cleared. Size:", getIdempotencyCacheSize());

  // Simulate request processing
  const mockRequest = {
    header: (name) => {
      if (name === "Idempotency-Key") return "test-key-123";
      return null;
    },
  };

  const mockResponse = {
    json: (body) => {
      console.log("Response sent:", body);
      return mockResponse;
    },
  };

  // Test middleware
  const idempotencyMiddleware =
    require("../middlewares/idempotency.js").idempotency();

  console.log("First request with key 'test-key-123'");
  idempotencyMiddleware(mockRequest, mockResponse, () => {
    console.log("Processing first request...");
    mockResponse.json({ id: 1, message: "Created" });
  });

  console.log("Cache size after first request:", getIdempotencyCacheSize());

  console.log("Second request with same key 'test-key-123'");
  idempotencyMiddleware(mockRequest, mockResponse, () => {
    console.log("This should not execute due to idempotency");
  });

  console.log("Cache size after second request:", getIdempotencyCacheSize());

  // Test without key
  const mockRequestNoKey = {
    header: (name) => null,
  };

  console.log("Request without Idempotency-Key");
  idempotencyMiddleware(mockRequestNoKey, mockResponse, () => {
    console.log("Processing request without key...");
  });

  console.log("Final cache size:", getIdempotencyCacheSize());
}

// Run test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testIdempotency();
}
