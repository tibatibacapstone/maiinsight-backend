import { Router } from "express";
import { authorize, authenticate } from "../middleware/auth.js";
import {
  getLatestSegmentation,
  getSegmentationCustomers,
  getSegmentationSummary,
  runRfmSegmentation,
} from "../services/rfmSegmentation.service.js";

export const segmentationRouter = Router();

segmentationRouter.use(authenticate);

segmentationRouter.post("/run", authorize("marketing", "it_support"), async (req, res, next) => {
  try {
    const data = await runRfmSegmentation({ k: req.body?.k });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

segmentationRouter.get("/latest", authorize("marketing", "management", "it_support"), async (req, res, next) => {
  try {
    const data = await getLatestSegmentation();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

segmentationRouter.get("/summary", authorize("marketing", "management", "it_support"), async (req, res, next) => {
  try {
    const data = await getSegmentationSummary();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

segmentationRouter.get("/customers", authorize("marketing", "management", "it_support"), async (req, res, next) => {
  try {
    const data = await getSegmentationCustomers();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});
