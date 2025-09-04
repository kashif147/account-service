# Service Template Documentation

## Overview

This service template provides a solid foundation for building Node.js microservices with Express, MongoDB, and RabbitMQ. It includes all the essential components needed for a production-ready service.

## Architecture

### Core Components

1. **Express Application** (`src/app.js`)

   - Middleware setup
   - Route configuration
   - Error handling
   - Health checks

2. **Configuration Management** (`src/config/`)

   - Environment-based configuration
   - Database connection
   - RabbitMQ setup
   - Logging configuration

3. **Middleware Stack** (`src/middlewares/`)

   - Authentication & Authorization
   - Request validation
   - Error handling
   - Logging
   - Idempotency
   - Security headers

4. **Business Logic** (`src/services/`)

   - Domain-specific operations
   - Data validation
   - External service integration

5. **API Layer** (`src/controllers/`)

   - Request/Response handling
   - Input validation
   - Error responses

6. **Data Layer** (`src/models/`)
   - Mongoose schemas
   - Database indexes
   - Data validation

## Key Features

### 1. Error Handling

The service uses a custom `AppError` class for consistent error responses:

```javascript
import { AppError } from "../errors/AppError.js";

// Usage examples
throw AppError.badRequest("Invalid input", { field: "email" });
throw AppError.notFound("Resource not found", { id: "123" });
throw AppError.unauthorized("Invalid credentials");
throw AppError.forbidden("Insufficient permissions");
```

### 2. Request Validation

All endpoints use express-validator for input validation:

```javascript
import { body, param } from "express-validator";
import { validate } from "../middlewares/validate.js";

export const createEntity = [
  body("name").trim().isLength({ min: 1 }).withMessage("Name is required"),
  body("email").isEmail().withMessage("Valid email is required"),
  validate,
  asyncHandler(async (req, res) => {
    // Handler logic
  }),
];
```

### 3. Structured Logging

Uses Pino for high-performance structured logging:

```javascript
import { logInfo, logError, logWarn } from "../middlewares/logger.mw.js";

logInfo("User created", { userId: "123", email: "user@example.com" });
logError("Database connection failed", { error: error.message });
logWarn("Rate limit exceeded", { ip: req.ip });
```

### 4. Event-Driven Architecture

RabbitMQ integration for asynchronous messaging:

```javascript
import { publishDomainEvent, EVENT_TYPES } from "../infra/rabbit/events.js";

await publishDomainEvent(
  EVENT_TYPES.USER_CREATED,
  { userId: "123", email: "user@example.com" },
  { source: "user.service", operation: "createUser" }
);
```

### 5. Health Monitoring

Multiple health check endpoints for monitoring:

- `/api/health` - Basic health status
- `/api/status` - Detailed system status
- `/api/health/idempotency` - Idempotency cache status
- `/api/health/logging` - Logging system status
- `/api/health/events` - Event system status

### 6. Security Features

- **Helmet.js** for security headers
- **CORS** configuration
- **Rate limiting** with express-rate-limit
- **JWT** authentication
- **Input validation** and sanitization
- **Content Security Policy** headers

### 7. API Documentation

Automatic Swagger documentation available at `/api/docs`

## Environment Configuration

The service supports multiple environments through dotenv-flow:

### Development (.env.development)

```bash
NODE_ENV=development
PORT=4000
MONGO_URI=mongodb://127.0.0.1:27017/service-dev
RABBIT_URL=amqp://localhost:5672
LOG_LEVEL=debug
```

### Staging (.env.staging)

```bash
NODE_ENV=staging
PORT=4000
MONGO_URI=mongodb://127.0.0.1:27017/service-staging
RABBIT_URL=amqp://localhost:5672
LOG_LEVEL=info
```

## Testing Strategy

### Unit Tests

- Service layer testing
- Model validation testing
- Utility function testing

### Integration Tests

- API endpoint testing
- Database integration testing
- External service integration testing

### Test Structure

```
src/tests/
├── unit/           # Unit tests
├── integration/    # Integration tests
└── fixtures/       # Test data
```

## Deployment

### Docker Support

The service can be containerized using Docker:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 4000
CMD ["npm", "start"]
```

### Environment Variables

Required environment variables:

- `NODE_ENV` - Environment (development/staging/production)
- `PORT` - Server port
- `MONGO_URI` - MongoDB connection string
- `RABBIT_URL` - RabbitMQ connection string
- `JWT_SECRET` - JWT signing secret
- `LOG_LEVEL` - Logging level

## Monitoring and Observability

### Logging

- Structured JSON logging with Pino
- Request/response logging
- Error tracking
- Performance metrics

### Health Checks

- Application health
- Database connectivity
- Message queue status
- External service dependencies

### Metrics

- Request count and duration
- Error rates
- Database query performance
- Memory usage

## Best Practices

1. **Error Handling**: Always use AppError for consistent error responses
2. **Validation**: Validate all inputs using express-validator
3. **Logging**: Use structured logging with appropriate log levels
4. **Security**: Keep dependencies updated and follow security best practices
5. **Testing**: Maintain high test coverage for critical paths
6. **Documentation**: Keep API documentation updated
7. **Monitoring**: Set up proper monitoring and alerting

## Troubleshooting

### Common Issues

1. **Database Connection Issues**

   - Check MongoDB connection string
   - Verify network connectivity
   - Check authentication credentials

2. **RabbitMQ Connection Issues**

   - Verify RabbitMQ server is running
   - Check connection string format
   - Ensure proper permissions

3. **Validation Errors**

   - Check request payload format
   - Verify required fields are present
   - Review validation rules

4. **Performance Issues**
   - Monitor database query performance
   - Check memory usage
   - Review logging levels

## Support

For issues and questions:

1. Check the logs for error details
2. Review the health check endpoints
3. Verify environment configuration
4. Check external service dependencies
