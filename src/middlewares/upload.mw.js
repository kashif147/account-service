import multer from "multer";

const storage = multer.memoryStorage();

export const uploadSingleOptional = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
}).single("file");
