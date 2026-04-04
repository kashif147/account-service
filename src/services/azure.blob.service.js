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

/**
 * Safe Content-Disposition for downloads: ASCII fallback + RFC 5987 filename*.
 */
function buildContentDispositionAttachment(originalName) {
  const base =
    ((originalName || "file").trim() || "file").split(/[/\\]/).pop() || "file";
  const noInject = base.replace(/[\r\n"]/g, "_").slice(0, 200);
  const asciiFallback =
    noInject.replace(/[^\x20-\x7E]/g, "_").replace(/[/\\]/g, "_") ||
    "download";
  const star = encodeURIComponent(base).replace(/'/g, "%27");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${star}`;
}

export async function uploadToBlob(
  blobPath,
  buffer,
  contentType,
  downloadFileName = null
) {
  if (!isConfigured) {
    throw new Error(
      "Azure Storage is not configured. Set AZURE_STORAGE_ACCOUNT and AZURE_STORAGE_KEY."
    );
  }
  const nameForDisposition =
    downloadFileName ||
    blobPath.split("/").pop() ||
    "file";
  const container = blobServiceClient.getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: {
      blobContentType: contentType || "application/octet-stream",
      blobContentDisposition: buildContentDispositionAttachment(nameForDisposition),
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

export async function deleteBlobIfExists(blobPath) {
  if (!isConfigured || !blobPath) return;
  const container = blobServiceClient.getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(blobPath);
  await blockBlob.deleteIfExists();
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
