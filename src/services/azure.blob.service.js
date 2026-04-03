import {
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from "@azure/storage-blob";
import {
  blobServiceClient,
  sharedKeyCredential,
  containerName,
  accountName,
  isConfigured,
} from "../config/azure.storage.js";

export async function uploadToBlob(blobPath, buffer, contentType) {
  if (!isConfigured) {
    throw new Error(
      "Azure Storage is not configured. Set AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY."
    );
  }
  const container = blobServiceClient.getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: contentType || "application/octet-stream",
    },
  });
  return blockBlob.url;
}

export async function downloadBlobToBuffer(blobPath) {
  if (!isConfigured) {
    throw new Error(
      "Azure Storage is not configured. Set AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY."
    );
  }
  const container = blobServiceClient.getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(blobPath);
  const downloadResponse = await blockBlob.download(0);
  const chunks = [];
  for await (const chunk of downloadResponse.readableStreamBody) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function generateDownloadUrl(blobPath, expiryMinutes = 60) {
  if (!isConfigured || !sharedKeyCredential) {
    throw new Error(
      "Azure Storage is not configured. Set AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY."
    );
  }
  const now = new Date();
  const expiry = new Date(now.getTime() + expiryMinutes * 60 * 1000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse("r"),
      startsOn: now,
      expiresOn: expiry,
    },
    sharedKeyCredential
  ).toString();
  return `https://${accountName}.blob.core.windows.net/${containerName}/${blobPath}?${sas}`;
}

export { isConfigured };
