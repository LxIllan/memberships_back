const Receipt = require("../models/receipt");
const logger = require("../config/logger");
const { validationResult } = require("express-validator");
const { strDateToStartEndDate } = require("../helpers/dates");

/*
 * @desc    Get receipts by anything
 */
const getReceiptsByX = (find, query) => {
    const page = query.page || 1;
    const limit = query.limit || 10;
    const skip = (page - 1) * limit;

    return Receipt.find(find)
        .populate("soldBy", "_id name lastName")
        .populate("boughtBy", "_id name lastName")
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit);
};

/*
 * @desc    Get all receipts
 * @route   GET /receipts
 */
exports.getReceipts = async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Validation errors. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }

    const date = strDateToStartEndDate(req.query.date);
    const find = { date: { $gte: date.start, $lt: date.end } };
    const receipts = await getReceiptsByX(find, req.query);
    
    if (receipts) {
        logger.info(`Get all receipts. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(200).json(receipts);
    } else {
        logger.warn(`Error getting all receipts. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: 'Error getting receipts.' });
    }
};

/*
 * @desc    Get receipts by member
 * @route   GET /receipts/member/:memberId
 */
exports.getReceiptsByMember = async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Validation errors. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }

    const find = { boughtBy: req.params.memberId };
    const receipts = await getReceiptsByX(find, req.query);

    if (receipts) {
        logger.info(`Get receipts by member. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(200).json(receipts);
    } else {
        logger.warn(`Error getting receipts by member. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: 'Error getting receipts.' });
    }
};

/*
 * @desc    Get receipts by user
 * @route   GET /receipts/user/:userId
 */
exports.getReceiptsByUser = async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Validation errors. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }

    const find = { soldBy: req.params.userId };
    const receipts = await getReceiptsByX(find, req.query);
    
    if (receipts) {
        logger.info(`Get receipts by user. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(200).json(receipts);
    } else {
        logger.warn(`Error getting receipts by user. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: 'Error getting receipts.' });
    }
};