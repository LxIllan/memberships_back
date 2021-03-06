const Member = require("../models/member");
const Receipt = require("../models/receipt");
const formidable = require("formidable");
const _ = require("lodash");
const { validationResult } = require("express-validator");
const fs = require("fs");
const { sendEmail, createCode } = require("../helpers/index");
const { addTimeToDate, isMemberActive, daysDiff, isMemberOnSchedule } = require("../helpers/dates");
const Membership = require("../models/membership");
const mongoose = require("mongoose");
const logger = require('../config/logger');

/*
 * @desc    Get a member by id, every time param '/:memberId' is called
 */
exports.memberById = (req, res, next, id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) {
        logger.warn(`Invalid member id. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(404).json({ error: `${id} is not a valid memberId` });
    }
    Member.findById(id)
        .populate("membership")
        .populate("payments", { path: "membership", sort: { date: -1 } })
        .populate("payments.membership", "_id membership")
        .exec((err, member) => {
            if (err || !member) {
                logger.warn(`Member not found. Method: ${req.method}, URL: ${req.url}.`);
                return res.status(404).json({ error: "Member not found" });
            }
            logger.info(`Member found by id. Method: ${req.method}, URL: ${req.url}.`);
            req.member = member;
            next();
        });
};

/*
 * @desc    Get a member by code
 * @route   GET /members/code/:code
 */
exports.getMemberByCode = (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Validation errors. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }
    if (/\d/.test(req.params.code)) {
        Member.findOne({ code: req.params.code })
            .populate("membership")
            .populate("payments", { path: "membership", sort: { date: -1 } })
            .populate("payments.membership", "_id membership")
            .exec((err, member) => {
                if (err || !member) {
                    logger.warn(`Member not found. Method: ${req.method}, URL: ${req.url}.`);
                    return res.status(404).json({ error: "Member not found" });
                }
                logger.info(`Member found by code. Method: ${req.method}, URL: ${req.url}.`);
                member.photo = undefined;
                return res.status(200).json(member);
            });
    } else {
        logger.warn(`Invalid code. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: `${req.body.code} is not a valid code.` });
    }
};

/*
 * @desc    Get a member by id
 * @route   GET /members/:memberId
 */
exports.getMember = (req, res) => {
    logger.info(`Get member. Method: ${req.method}, URL: ${req.url}.`);
    return res.status(200).json(req.member);
};

/*
 * @desc    Sing up a member
 * @route   POST /members
 ! Every member must have a unique email and code
 TODO: Validate incoming form.
*/
exports.registerMember = async (req, res) => {
    let form = new formidable.IncomingForm();
    form.keepExtensions = true;
    form.parse(req, async (err, fields, files) => {
        if (err) {
            logger.warn(`Photo could not be uploaded. Method: ${req.method}, URL: ${req.url}.`);
            return res.status(400).json({ error: "Photo could not be uploaded" });
        }
        const memberExists = await Member.findOne({ email: fields.email.toLowerCase() });
        if (memberExists) {
            logger.warn(`Email taken. Method: ${req.method}, URL: ${req.url}.`);
            return res.status(403).json({
                error: "Email is taken!",
            });
        }

        // Make sure the code generated is unique
        let isCodeTaken = true;
        let code;
        while (isCodeTaken) {
            code = createCode();
            const memberExists = await Member.findOne({ code });
            if (!memberExists) {
                isCodeTaken = false;
            }
        }

        const membership = await Membership.findById(fields.membership);

        fields.endMembership = addTimeToDate(new Date(), membership.months, membership.weeks);
        let member = new Member(fields);
        member.code = code;
        member.membership = membership;
        member.email = fields.email.toLowerCase();
        if (files.photo) {
            member.photo.data = fs.readFileSync(files.photo.filepath);
            member.photo.contentType = files.photo.mimetype;
        }
        member.payments = [{ date: Date.now(), membership: membership }];

        const emailData = {
            from: "mailer@syss.tech",
            to: member.email,
            subject: "Welcome to {memberships_place}",
            text: `Welcome to {memberships_place} you have paid ${membership.membership} which ends on ${member.endMembership}`,
            html: `<p>Welcome to {memberships_place} you have paid ${membership.membership} which ends on ${member.endMembership}</p>`,
        };

        member.save((err, result) => {
            if (err) {
                logger.warn(`Member could not be saved. Method: ${req.method}, URL: ${req.url}.`);
                return res.status(400).json({ error: err });
            }
            let receipt = new Receipt({
                membership: membership.membership,
                price: membership.price,
                boughtBy: member,
                soldBy: new mongoose.mongo.ObjectId(fields.userId),
                date: Date.now(),
            });
            receipt.save((err, result) => {
                if (err) {
                    logger.warn(`Receipt did not save. Method: ${req.method}, URL: ${req.url}.`);
                    return res.status(400).json({ error: "Receipt did not save" });
                }
            });
            logger.info(`Member has been registered. Method: ${req.method}, URL: ${req.url}.`);
            sendEmail(emailData);
            res.status(201).json(member);
        });
    });
};

/*
 * @desc    Get a member photo in other endpoint
 * @route   GET /members/photo/:memberId
 */
exports.getMemberPhoto = (req, res, next) => {
    if (req.member.photo.data) {
        res.setHeader("Content-Type", req.member.photo.contentType);
        logger.info(`Serving member photo. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(200).send(req.member.photo.data);
    }
    logger.info(`Member has no photo. Method: ${req.method}, URL: ${req.url}.`);
    next();
};

/*
 * @desc    Get all members
 * @route   GET /members
 ? For the moment it searches by name or last name.
 */
exports.getMembers = (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Validation errors. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }

    const page = req.query.page || 1;
    const limit = req.query.limit || 10;
    const skip = (page - 1) * limit;
    const name = req.query.name || "";

    Member.find({
            $or: [
                { name: { $regex: name, $options: "i" } },
                { lastName: { $regex: name, $options: "i" } },
            ],
        })
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .select("name lastName code endMembership")
        .exec((err, members) => {
            if (err) {
                logger.warn(`Error getting members. Method: ${req.method}, URL: ${req.url}.`);
                return res.status(400).json({ error: err });
            }
            logger.warn(`Get members. Method: ${req.method}, URL: ${req.url}.`);
            res.status(200).json(members);
        });
};

/*
 * @desc    Send notification by email to all active members
 * @route   PUT /members/send-notification
 */
exports.sendNotification = (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Validation errors. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }

    const emailData = {
        from: "mailer@syss.tech",
        subject: req.body.subject,
        text: req.body.body,
        html: `<p>${req.body.body}</p>`,
    };

    Member.find({ endMembership: { $gte: new Date() } }, (err, members) => {
        if (err) {
            logger.warn(`Error getting active members. Method: ${req.method}, URL: ${req.url}.`);
            return res.status(400).json({ error: err });
        }
        const mailList = [];
        members.forEach((member) => {
            if (member.email) {
                mailList.push(member.email);
            }
        });
        emailData.to = mailList;
        sendEmail(emailData);
        logger.info(`Notification has been sent. Method: ${req.method}, URL: ${req.url}.`);
        res.status(200).json({ message: "Success!" });
    }).select("email");
};

/*
 * @desc    Cron job to email a members whose membership ends in 7 days
 */
exports.sendEmailEndMembership = () => {
    const emailData = {
        from: "mailer@syss.tech",
        subject: "Your membership ends in 7 days",
        text: "",
        html: `<p></p>`,
    };

    Member.find({ endMembership: { $gte: new Date() } }, (err, members) => {
        if (err) {
            logger.warn(`Error getting active members. Method: ${req.method}, URL: ${req.url}.`);
            return res.status(400).json({ error: err });
        }
        members.forEach((member) => {
            if (daysDiff(new Date(), member.endMembership) === 7) {
                if (member.email) {
                    emailData.text = `Dear ${member.name} ${member.lastName} your membership ends in 7 days, in ${member.endMembership}`;
                    emailData.html = `<p>${emailData.text}</p>`;
                    emailData.to = member.email;
                    logger.info(`Notification end membership has been sent. Method: ${req.method}, URL: ${req.url}.`);
                    sendEmail(emailData);
                }
            }
        });
    }).select("name lastName endMembership email");
};

/*
 * @desc    Set assistance to member
 * @route   PUT /members/assistance
 ! Member must be active and on time to get assistance.
*/
exports.setAssistance = (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Validation errors. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }

    Member.findById(req.body.memberId)
        .populate("payments", "membership")
        .populate("membership", "membership specialHours")
        .populate("payments.membership", "_id membership")
        .exec(async (err, member) => {
            if (err || !member) {
                logger.warn(`Member not found. Method: ${req.method}, URL: ${req.url}.`);
                return res.status(404).json({ error: "Member not found" });
            }
            if (isMemberActive(member.endMembership)) {
                if (
                    !isMemberOnSchedule(
                        member.membership.specialHours.startHour,
                        member.membership.specialHours.endHour
                    )
                ) {
                    logger.warn(`User out of schedule. Method: ${req.method}, URL: ${req.url}.`);
                    return res.status(400).json({ error: "User out of schedule." });
                }
                member.assistances.push(Date.now());
                member.save((err, member) => {
                    if (err) {
                        logger.warn(`User could not be saved. Method: ${req.method}, URL: ${req.url}.`);
                        return res.status(400).json({ error: err });
                    }
                    logger.info(`Set assistance to member. Method: ${req.method}, URL: ${req.url}.`);
                    res.status(200).json(member);
                });
            } else {
                logger.warn(`User has no active membership. Method: ${req.method}, URL: ${req.url}.`);
                return res.status(400).json({ error: "User has no active membership" });
            }
        });
};

/*
 * @desc    Set assistance to member
 * @route   PUT /members/assistance
 ? Members can pay even if their memberships has not ended.
*/
exports.payMembership = (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn(`Validation errors. Method: ${req.method}, URL: ${req.url}.`);
        return res.status(400).json({ error: errors.array().map((e) => e.msg) });
    }

    Member.findById(req.body.memberId)
        .populate("payments", "membership")
        .populate("membership", "membership")
        .populate("payments.membership", "_id membership")
        .exec(async (err, member) => {
            if (err || !member) {
                logger.warn(`Member not found. Method: ${req.method}, URL: ${req.url}.`);
                return res.status(404).json({ error: "Member not found" });
            }
            const membership = await Membership.findById(req.body.membership);
            if (isMemberActive(member.endMembership)) {
                member.endMembership = addTimeToDate(
                    new Date(member.endMembership),
                    membership.months,
                    membership.weeks
                );
            } else {
                member.endMembership = addTimeToDate(
                    new Date(req.body.date + " 00:00:00"),
                    membership.months,
                    membership.weeks
                );
            }
            member.membership = membership;
            member.payments.push({ date: Date.now(), membership });

            const emailData = {
                from: "mailer@syss.tech",
                to: member.email,
                subject: "{memberships_place} Receipt",
                text: `You have paid ${
                    membership.membership
                } which ends on ${member.endMembership.toUTCString()}`,
                html: `<p>You have paid ${
                    membership.membership
                } which ends on ${member.endMembership.toUTCString()}</p>`,
            };

            member.save((err, member) => {
                if (err) {
                    logger.warn(`Member could not be saved. Method: ${req.method}, URL: ${req.url}.`);
                    return res.status(400).json({ error: err });
                }
                let receipt = new Receipt({
                    membership: membership.membership,
                    price: membership.price,
                    boughtBy: member,
                    soldBy: new mongoose.mongo.ObjectId(req.body.userId),
                    date: Date.now(),
                });
                receipt.save((err, result) => {
                    if (err) {
                        logger.warn(`Receipt did not save. Method: ${req.method}, URL: ${req.url}.`);
                        return res.status(400).json({ error: "Receipt did not save." });
                    }
                });
                logger.info(`Member paid a membership. Method: ${req.method}, URL: ${req.url}.`);
                sendEmail(emailData);
                res.status(200).json(member);
            });
        });
};

/*
 * @desc    Update a member
 * @route   PUT /members/:memberId
 TODO: Validate incoming form.
 ! Membership cannot be updated here.
*/
exports.updateMember = (req, res) => {
    let form = new formidable.IncomingForm();
    form.keepExtensions = true;
    form.parse(req, async (err, fields, files) => {
        if (err) {
            logger.warn(`Photo could not be uploaded. Method: ${req.method}, URL: ${req.url}.`);
            return res.status(400).json({ error: "Photo could not be uploaded." });
        }
        let member = req.member;
        if (fields.email) {
            const memberExists = await Member.findOne({ email: fields.email.toLowerCase() });
            if (memberExists) {
                if (!member._id.equals(memberExists._id)) {
                    logger.warn(`Email taken. Method: ${req.method}, URL: ${req.url}.`);
                    return res.status(400).json({ error: "Email is taken!" });
                }
            }
        }
        member = _.extend(member, fields);
        member.updatedAt = Date.now();
        member.email = member.email.toLowerCase();
        if (files.photo) {
            member.photo.data = fs.readFileSync(files.photo.filepath);
            member.photo.contentType = files.photo.mimetype;
        }
        member.save((err, result) => {
            if (err) {
                logger.warn(`Member could not be updated. Method: ${req.method}, URL: ${req.url}.`);
                return res.status(400).json({ error: err });
            }
            logger.info(`Member has been updated. Method: ${req.method}, URL: ${req.url}.`);
            return res.status(200).json(member);
        });
    });
};

/*
 * @desc    Remove a member
 * @route   DELETE /members/:memberId
 ? Members can be deleted even if their membership is active.
*/
exports.deleteMember = (req, res) => {
    let member = req.member;
    member.remove((err, result) => {
        if (err) {
            logger.warn(`Member could not be deleted. Method: ${req.method}, URL: ${req.url}.`);
            return res.status(400).json({ error: err });
        }
        logger.info(`Member has been deleted. Method: ${req.method}, URL: ${req.url}.`);
        res.status(200).json({ message: "Member has been deleted successfully!" });
    });
};
