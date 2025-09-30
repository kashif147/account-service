# Account Service

Node.js Express microservice with MongoDB (Mongoose), Stripe payments, and idempotent APIs.

## Features

- **Express.js** with ES modules
- **MongoDB** with Mongoose ODM
- **RabbitMQ** messaging with event-driven architecture
- **JWT** authentication and authorization
- **Request validation** with express-validator
- **Structured logging** with Pino
- **API documentation** with Swagger
- **Rate limiting** and security headers
- **Idempotency** support
- **Error handling** with custom AppError class
- **Testing** setup with Jest
- **Environment management** with dotenv-flow
- **CORS** and security middleware
- **Health checks** and monitoring endpoints

## Quick Start

1. **Clone and customize**:

   ```bash
   cp -r service-template your-service-name
   cd your-service-name
   ```

2. **Update package.json**:

   - Change `name` to your service name
   - Update `main` entry point if needed
   - Modify scripts as required

3. **Configure environment**:

   ```bash
   cp .env.development .env.development
   cp .env.staging .env.staging
   # Edit the environment files with your configuration
   ```

4. **Install dependencies**:

   ```bash
   npm install
   ```

5. **Start development server**:
   ```bash
   npm run dev
   ```

## Project Structure

```
├── bin/
│   └── service.js              # Application entry point
├── src/
│   ├── config/                 # Configuration files
│   │   ├── cors.js            # CORS configuration
│   │   ├── db.js              # Database connection
│   │   ├── index.js           # Main config
│   │   ├── logger.js          # Logging configuration
│   │   ├── rabbit.js          # RabbitMQ configuration
│   │   ├── rateLimiters.js    # Rate limiting
│   │   ├── roles.js           # Role-based access
│   │   ├── security.js        # Security headers
│   │   └── swagger.js         # API documentation
│   ├── controllers/           # Route controllers
│   │   ├── health.controller.js
│   │   └── template.controller.js
│   ├── errors/                # Error handling
│   │   └── AppError.js        # Custom error class
│   ├── handlers/              # Event handlers
│   ├── helpers/               # Utility functions
│   │   └── asyncHandler.js    # Async error wrapper
│   ├── infra/                 # Infrastructure
│   │   └── rabbit/            # RabbitMQ setup
│   ├── middlewares/           # Express middlewares
│   │   ├── auth.js            # Authentication
│   │   ├── errorHandler.js    # Error handling
│   │   ├── idempotency.js     # Idempotency
│   │   ├── logger.mw.js       # Request logging
│   │   ├── notFound.js        # 404 handler
│   │   ├── requestId.js       # Request ID
│   │   ├── response.mw.js     # Response formatting
│   │   ├── validate.js        # Validation (Zod wrapper)
│   │   ├── context.js         # Request context (tenant/api key)
│   │   ├── verifyJWT.js       # JWT verification
│   │   └── verifyRoles.js     # Role verification
│   ├── models/                # Mongoose models
│   │   ├── Payment.js
│   │   └── Refund.js
│   ├── routes/                # Route definitions
│   │   ├── index.js           # Main router
│   │   └── payments.js
│   ├── services/              # Business logic
│   │   └── payments.js
│   ├── lib/
│   │   └── stripe.js          # Stripe client
│   ├── tests/                 # Test files
│   ├── validators/            # Validation schemas
│   ├── docs/                  # Documentation
│   └── app.js                 # Express app setup
├── .env.development           # Development environment
├── .env.staging              # Staging environment
├── .gitignore                # Git ignore rules
├── jest.config.js            # Jest configuration
└── package.json              # Dependencies and scripts
```

## Customization Guide

### 1. Replace Template Components

- **Models**: Replace `template.model.js` with your domain models
- **Services**: Update `template.service.js` with your business logic
- **Controllers**: Modify `template.controller.js` with your API endpoints
- **Routes**: Update `template.routes.js` with your route definitions

### 2. Environment Configuration

Create environment-specific files:

- `.env.development` - Development settings
- `.env.staging` - Staging settings
- `.env.production` - Production settings (if needed)

### 3. Database Models

Create your Mongoose models in `src/models/`:

```javascript
import mongoose from "mongoose";

const yourSchema = new mongoose.Schema(
  {
    // Your schema definition
  },
  {
    timestamps: true,
  }
);

export default mongoose.model("YourModel", yourSchema);
```

### 4. Business Logic

Implement your services in `src/services/`:

```javascript
import YourModel from "../models/your.model.js";
import { AppError } from "../errors/AppError.js";

export async function createYourEntity(data) {
  // Your business logic
}
```

### 5. API Endpoints

Define your controllers in `src/controllers/`:

```javascript
import { body } from "express-validator";
import { validate } from "../middlewares/validate.js";
import { asyncHandler } from "../helpers/asyncHandler.js";

export const createYourEntity = [
  body("field").isRequired(),
  validate,
  asyncHandler(async (req, res) => {
    // Your endpoint logic
  }),
];
```

### 6. Routes

Update your routes in `src/routes/`:

```javascript
import express from "express";
import * as yourController from "../controllers/your.controller.js";

const router = express.Router();
router.post("/your-endpoint", yourController.createYourEntity);
export default router;
```

## Environment Variables

Use dotenv-flow to provide these:

- MONGODB_URI: Mongo connection string
- STRIPE_SECRET_KEY: Stripe Secret Key
- ACCOUNTS_API_KEY: Shared API key for requests
- PORTAL_BASE_URL: Portal base for checkout success/cancel URLs

## Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon
- `npm run start:dev` - Start with development environment
- `npm run start:staging` - Start with staging environment
- `npm test` - Run tests
- `npm run unittest` - Run unit tests

## API Documentation

Once the server is running, visit `/api/docs` for Swagger documentation.

## Health Endpoints

- `GET /api/health` - Basic health check
- `GET /api/status` - Detailed status information
- `GET /api/health/idempotency` - Idempotency cache status
- `GET /api/health/logging` - Logging system status
- `GET /api/health/events` - Event system status

## Best Practices

1. **Error Handling**: Use the `AppError` class for consistent error responses
2. **Validation**: Always validate input using express-validator
3. **Logging**: Use structured logging with Pino
4. **Async Operations**: Wrap async handlers with `asyncHandler`
5. **Security**: Keep environment variables secure
6. **Testing**: Write tests for all business logic
7. **Documentation**: Keep API documentation updated

## Dependencies

### Core Dependencies

- `express` - Web framework
- `mongoose` - MongoDB ODM
- `amqplib` - RabbitMQ client
- `pino` - Logging
- `jsonwebtoken` - JWT authentication
- `express-validator` - Input validation
- `helmet` - Security headers
- `cors` - CORS middleware
- `compression` - Response compression

### Development Dependencies

- `nodemon` - Development server
- `jest` - Testing framework
- `supertest` - API testing
- `cross-env` - Environment variables
- `pino-pretty` - Pretty logging

## License

## Payments API

All endpoints require headers:

- x-tenant-id: demo-tenant
- x-api-key: ${ACCOUNTS_API_KEY}
- x-idempotency-key: demo-tenant:member-123:1690000000000

### Create Intent

```bash
curl -X POST http://localhost:4000/api/payments/intents \
  -H "content-type: application/json" \
  -H "x-tenant-id: demo-tenant" \
  -H "x-api-key: $ACCOUNTS_API_KEY" \
  -H "x-idempotency-key: demo-tenant:member-123:1690000000000" \
  -d '{"purpose":"subscriptionFee","amount":500,"currency":"eur"}'
```

### Create Intent (Checkout)

```bash
curl -X POST http://localhost:4000/api/payments/intents \
  -H "content-type: application/json" \
  -H "x-tenant-id: demo-tenant" \
  -H "x-api-key: $ACCOUNTS_API_KEY" \
  -H "x-idempotency-key: demo-tenant:member-123:1690000000000" \
  -d '{"purpose":"subscriptionFee","amount":500,"currency":"eur","useCheckout":true}'
```

### Reconcile

```bash
curl -X POST http://localhost:4000/api/payments/reconcile \
  -H "content-type: application/json" \
  -H "x-tenant-id: demo-tenant" \
  -H "x-api-key: $ACCOUNTS_API_KEY" \
  -H "x-idempotency-key: demo-tenant:member-123:1690000000000" \
  -d '{"eventId":"evt_1","type":"payment_intent.succeeded","payment":{"paymentIntentId":"pi_123","amount":500,"currency":"eur","status":"succeeded"}}'
```

### Get by Stripe Intent

```bash
curl http://localhost:4000/api/payments/by-stripe/pi_123 \
  -H "x-tenant-id: demo-tenant" \
  -H "x-api-key: $ACCOUNTS_API_KEY"
```

### Record External

```bash
curl -X POST http://localhost:4000/api/payments/record-external \
  -H "content-type: application/json" \
  -H "x-tenant-id: demo-tenant" \
  -H "x-api-key: $ACCOUNTS_API_KEY" \
  -d '{"direction":"in","amount":500,"currency":"eur","reason":"cash"}'
```

### Refunds

```bash
curl -X POST http://localhost:4000/api/payments/refunds \
  -H "content-type: application/json" \
  -H "x-tenant-id: demo-tenant" \
  -H "x-api-key: $ACCOUNTS_API_KEY" \
  -H "x-idempotency-key: demo-tenant:member-123:1690000000000" \
  -d '{"mode":"stripe","paymentIntentId":"pi_123","amount":100}'
```

MIT License - feel free to use this template for your projects.
