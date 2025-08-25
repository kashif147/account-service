export default {
  testEnvironment: "node",
  roots: ["<rootDir>"],
  moduleFileExtensions: ["js", "json"],
  testMatch: ["**/__tests__/**/*.js", "**/?(*.)+(spec|test).js"],
  collectCoverageFrom: ["**/*.js", "!**/node_modules/**", "!**/coverage/**", "!jest.config.js", "!server.js"],
};

// export default {
//   testEnvironment: "node",
//   roots: ["<rootDir>/src"],
//   moduleFileExtensions: ["js", "json"]
// };
