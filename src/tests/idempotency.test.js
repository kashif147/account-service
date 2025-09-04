import {
  clearIdempotencyCache,
  getIdempotencyCacheSize,
  idempotency,
} from "../middlewares/idempotency.js";

// Test idempotency functionality
describe("Idempotency Middleware", () => {
  beforeEach(() => {
    // Clear cache before each test
    clearIdempotencyCache();
  });

  it("should process first request with idempotency key", () => {
    const mockRequest = {
      header: (name) => {
        if (name === "Idempotency-Key") return "test-key-123";
        return null;
      },
    };

    const mockResponse = {
      status: (code) => mockResponse,
      json: (body) => {
        return mockResponse;
      },
    };

    const idempotencyMiddleware = idempotency();

    idempotencyMiddleware(mockRequest, mockResponse, () => {
      mockResponse.json({ id: 1, message: "Created" });
    });

    expect(getIdempotencyCacheSize()).toBeGreaterThan(0);
  });

  it("should handle duplicate requests with same idempotency key", () => {
    const mockRequest = {
      header: (name) => {
        if (name === "Idempotency-Key") return "test-key-123";
        return null;
      },
    };

    const mockResponse = {
      status: (code) => mockResponse,
      json: (body) => {
        return mockResponse;
      },
    };

    const idempotencyMiddleware = idempotency();

    // First request
    idempotencyMiddleware(mockRequest, mockResponse, () => {
      mockResponse.json({ id: 1, message: "Created" });
    });

    const initialCacheSize = getIdempotencyCacheSize();

    // Second request with same key
    idempotencyMiddleware(mockRequest, mockResponse, () => {
      // This should not execute due to idempotency
    });

    expect(getIdempotencyCacheSize()).toBe(initialCacheSize);
  });

  it("should process requests without idempotency key", () => {
    const mockRequestNoKey = {
      header: (name) => null,
    };

    const mockResponse = {
      status: (code) => mockResponse,
      json: (body) => {
        return mockResponse;
      },
    };

    const idempotencyMiddleware = idempotency();

    idempotencyMiddleware(mockRequestNoKey, mockResponse, () => {
      // Processing request without key
    });

    expect(getIdempotencyCacheSize()).toBe(0);
  });
});
