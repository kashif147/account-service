import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";

const connectionString = (process.env.AZURE_STORAGE_CONNECTION_STRING || "")
  .replace(/\s+/g, " ")
  .trim();
const accountName = (process.env.AZURE_STORAGE_ACCOUNT || "").trim();
const accountKey = (process.env.AZURE_STORAGE_KEY || "")
  .replace(/\r?\n/g, "")
  .trim();
const containerName = (process.env.AZURE_STORAGE_CONTAINER || "").trim();

let blobServiceClient = null;
let sharedKeyCredential = null;
let resolvedAccountName = accountName;

if (connectionString) {
  blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const match = connectionString.match(/AccountName=([^;]+)/);
  resolvedAccountName = match ? match[1].trim() : accountName;
  const keyMatch = connectionString.match(/AccountKey=([^;]+)/);
  if (keyMatch && keyMatch[1]) {
    sharedKeyCredential = new StorageSharedKeyCredential(
      resolvedAccountName,
      keyMatch[1].trim()
    );
  }
} else if (accountName && accountKey) {
  sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);
  blobServiceClient = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    sharedKeyCredential
  );
}

const isConfigured = Boolean(blobServiceClient);

export {
  blobServiceClient,
  sharedKeyCredential,
  containerName,
  resolvedAccountName as accountName,
  isConfigured,
};
