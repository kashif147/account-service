#!/bin/bash

# Authorization System Migration Script
# This script helps copy the authorization system files to other services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if target service path is provided
if [ $# -eq 0 ]; then
    print_error "Usage: $0 <target-service-path>"
    print_error "Example: $0 ../user-service"
    exit 1
fi

TARGET_SERVICE=$1

# Check if target directory exists
if [ ! -d "$TARGET_SERVICE" ]; then
    print_error "Target service directory does not exist: $TARGET_SERVICE"
    exit 1
fi

# Get the current directory (account-service)
SOURCE_DIR=$(pwd)

print_status "Copying authorization system from $SOURCE_DIR to $TARGET_SERVICE"

# Create necessary directories in target service
mkdir -p "$TARGET_SERVICE/src/config"
mkdir -p "$TARGET_SERVICE/src/middlewares"
mkdir -p "$TARGET_SERVICE/src/errors"

# Copy core files
print_status "Copying roleHierarchy.js..."
cp "$SOURCE_DIR/src/config/roleHierarchy.js" "$TARGET_SERVICE/src/config/"

print_status "Copying auth.js..."
cp "$SOURCE_DIR/src/middlewares/auth.js" "$TARGET_SERVICE/src/middlewares/"

print_status "Copying verifyRoles.js..."
cp "$SOURCE_DIR/src/middlewares/verifyRoles.js" "$TARGET_SERVICE/src/middlewares/"

print_status "Copying AppError.js..."
cp "$SOURCE_DIR/src/errors/AppError.js" "$TARGET_SERVICE/src/errors/"

# Copy documentation
print_status "Copying documentation..."
mkdir -p "$TARGET_SERVICE/src/docs"
cp "$SOURCE_DIR/src/docs/AUTHORIZATION_SYSTEM.md" "$TARGET_SERVICE/src/docs/"
cp "$SOURCE_DIR/src/docs/AUTHORIZATION_MIGRATION_GUIDE.md" "$TARGET_SERVICE/src/docs/"

print_status "Files copied successfully!"

# Check if package.json exists and suggest dependencies
if [ -f "$TARGET_SERVICE/package.json" ]; then
    print_status "Checking dependencies..."
    
    if ! grep -q "jsonwebtoken" "$TARGET_SERVICE/package.json"; then
        print_warning "jsonwebtoken dependency not found in package.json"
        print_warning "Run: cd $TARGET_SERVICE && npm install jsonwebtoken"
    else
        print_status "jsonwebtoken dependency found ✓"
    fi
else
    print_warning "package.json not found in target service"
fi

# Check for environment variables
if [ -f "$TARGET_SERVICE/.env" ] || [ -f "$TARGET_SERVICE/.env.example" ]; then
    print_status "Checking environment variables..."
    
    if [ -f "$TARGET_SERVICE/.env" ]; then
        if ! grep -q "JWT_SECRET" "$TARGET_SERVICE/.env"; then
            print_warning "JWT_SECRET not found in .env file"
            print_warning "Add: JWT_SECRET=your-jwt-secret-key"
        else
            print_status "JWT_SECRET found in .env ✓"
        fi
    fi
else
    print_warning "No .env file found. Make sure to set JWT_SECRET environment variable"
fi

print_status "Migration completed!"
print_status ""
print_status "Next steps:"
print_status "1. Update import paths in copied files if needed"
print_status "2. Install dependencies: npm install jsonwebtoken"
print_status "3. Set JWT_SECRET environment variable"
print_status "4. Update your route files to use the new middleware"
print_status "5. Test the authorization system"
print_status ""
print_status "See AUTHORIZATION_MIGRATION_GUIDE.md for detailed instructions"
