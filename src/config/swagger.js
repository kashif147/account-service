import swaggerUi from "swagger-ui-express";
import swaggerJSDoc from "swagger-jsdoc";

const options = {
  definition: {
    openapi: "3.0.0",
    info: { title: "Accounts Service API", version: "1.0.0" },
    servers: [{ url: "/api" }]
  },
  apis: ["./src/routes/*.js"]
};

const spec = swaggerJSDoc(options);

export const swaggerServe = swaggerUi.serve;
export const swaggerSetup = swaggerUi.setup(spec, { explorer: true });
