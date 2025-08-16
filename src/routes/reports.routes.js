import express from "express";
import { memberStatement, balancesSnapshot } from "../controllers/reports.controller.js";

const router = express.Router();
router.get("/member/:memberId/statement", memberStatement);
router.get("/balances", balancesSnapshot);

export default router;
