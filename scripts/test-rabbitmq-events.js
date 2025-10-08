#!/usr/bin/env node

/**
 * RabbitMQ Event Testing Script
 *
 * This script helps test RabbitMQ event publishing functionality
 * Usage: node scripts/test-rabbitmq-events.js
 */

import { publishDomainEvent } from "../src/rabbitMQ/events.js";
import { APPLICATION_EVENTS } from "../src/rabbitMQ/events/application.events.js";
import { PAYMENT_EVENTS } from "../src/rabbitMQ/events/payment.events.js";
import { JOURNAL_EVENTS } from "../src/rabbitMQ/events/journal.events.js";
import logger from "../src/config/logger.js";

async function testEventPublishing() {
  console.log("🚀 Starting RabbitMQ Event Publishing Tests...\n");

  const testCases = [
    {
      name: "Application Status Update Event",
      eventType: APPLICATION_EVENTS.STATUS_UPDATED,
      data: {
        applicationId: "test-app-123",
        status: "submitted",
        paymentIntentId: "pi_test_123",
        amount: 2000,
        currency: "usd",
        tenantId: "test-tenant-456",
      },
      metadata: {
        source: "test-script",
        testCase: "application-status-update",
      },
    },
    {
      name: "Payment Received Event",
      eventType: PAYMENT_EVENTS.RECEIVED,
      data: {
        paymentId: "pay_test_123",
        amount: 1000,
        currency: "usd",
        memberId: "member_123",
        tenantId: "test-tenant-456",
      },
      metadata: {
        source: "test-script",
        testCase: "payment-received",
      },
    },
    {
      name: "Journal Created Event",
      eventType: JOURNAL_EVENTS.CREATED,
      data: {
        journalId: "journal_test_123",
        amount: 500,
        description: "Test journal entry",
        tenantId: "test-tenant-456",
      },
      metadata: {
        source: "test-script",
        testCase: "journal-created",
      },
    },
  ];

  let successCount = 0;
  let failureCount = 0;

  for (const testCase of testCases) {
    try {
      console.log(`📤 Testing: ${testCase.name}`);
      console.log(`   Event Type: ${testCase.eventType}`);
      console.log(`   Data:`, JSON.stringify(testCase.data, null, 2));

      const success = await publishDomainEvent(
        testCase.eventType,
        testCase.data,
        testCase.metadata
      );

      if (success) {
        console.log("   ✅ Event published successfully\n");
        successCount++;
      } else {
        console.log("   ❌ Event publishing failed\n");
        failureCount++;
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}\n`);
      failureCount++;
    }

    // Wait a bit between events
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log("📊 Test Results:");
  console.log(`   ✅ Successful: ${successCount}`);
  console.log(`   ❌ Failed: ${failureCount}`);
  console.log(
    `   📈 Success Rate: ${((successCount / testCases.length) * 100).toFixed(
      1
    )}%`
  );

  if (failureCount > 0) {
    console.log("\n⚠️  Some events failed to publish. Check:");
    console.log("   - RabbitMQ server is running");
    console.log("   - RABBIT_URL environment variable is set correctly");
    console.log("   - Network connectivity to RabbitMQ");
    process.exit(1);
  } else {
    console.log("\n🎉 All events published successfully!");
    process.exit(0);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Test interrupted by user");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n👋 Test terminated");
  process.exit(0);
});

// Run the tests
testEventPublishing().catch((error) => {
  console.error("💥 Test script failed:", error);
  process.exit(1);
});
