import express from "express";
import { listCoA } from "../controllers/admin.controller.js";

const router = express.Router();
router.get("/coa", listCoA);

export default router;
