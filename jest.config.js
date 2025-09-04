export default {
  globals: {
    "ts-jest": {
      useESM: true,
    },
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testEnvironment: "node",
  transform: {},
  testMatch: ["**/tests/**/*.test.js"],
  collectCoverageFrom: ["src/**/*.js", "!src/**/*.test.js", "!src/docs/**"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  passWithNoTests: true,
  testTimeout: 10000,
  forceExit: true,
};
