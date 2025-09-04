// Template test file - replace with your service-specific tests
import request from "supertest";
import app from "../app.js";

describe("Health Endpoints", () => {
  test("GET /api/health should return 200", async () => {
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe("healthy");
  });

  test("GET /api/status should return 200", async () => {
    const response = await request(app).get("/api/status");
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe("operational");
  });
});

describe("Template Endpoints", () => {
  test("GET /api/templates should return 200", async () => {
    const response = await request(app).get("/api/templates");
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(Array.isArray(response.body.data.templates)).toBe(true);
  });

  test("POST /api/templates should validate required fields", async () => {
    const response = await request(app)
      .post("/api/templates")
      .send({ description: "Test description" });
    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });
});
