const express = require("express");
const router = express.Router();
const {
  register,
  login,
  verifyOTP,
  requestPasswordReset,
  verifyAndResetPassword,

  getAllUsers,
  getUserByEmail,
  uploadProfileImage,
  updateUserProfile,
  updateDocuments,
  updateBankDetails,
  changePassword,
  verifyKyc, // ✅ new controller
  getUnverifiedUsers,
  deleteUser,
  approveBankDetails,
  rejectUserKyc,
  userByReferralCode,
} = require("../controllers/authController");
const upload = require("../middleware/cloudinaryUploader");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const { canApproveTrading } = require("../services/adminPolicy");
const adminAuth = require("../controllers/adminAuthController");
const { rateLimit } = require("express-rate-limit");
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false,
  message: { message: "Too many administrator sign-in attempts. Please try again later." } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true,
  standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many sign-in attempts. Please try again later." } });
const registration = require("../controllers/registrationController");
const multer = require("multer");
const ownerTradingReview = require("../controllers/ownerTradingReviewController");
const ownerEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: upload.MAX_FILE_SIZE_MB * 1024 * 1024, fieldSize: 2048, fields: 5, files: 2, parts: 8 },
}).fields([{ name: "identity", maxCount: 1 }, { name: "address", maxCount: 1 }]);
const registrationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10,
  standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many registration requests. Please try again later." } });
const registrationCodeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40,
  standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many verification requests. Please try again later." } });

router.get("/registration-options", registration.options);
router.post("/register", registrationLimiter, register);
router.post("/verify-otp", registrationCodeLimiter, verifyOTP);
router.post("/registration/resend-email", registrationCodeLimiter, registration.resendEmail);
router.post("/registration/send-mobile", registrationCodeLimiter, registration.sendMobile);
router.post("/registration/verify-mobile", registrationCodeLimiter, registration.verifyMobile);
router.post("/login", loginLimiter, login);
router.post("/request-reset", loginLimiter, requestPasswordReset);
router.post("/verify-reset-otp", loginLimiter, verifyAndResetPassword);
router.post("/admin/request-code", adminLimiter, adminAuth.requestCode);
router.post("/admin/verify-code", adminLimiter, adminAuth.verifyCode);

router.use(auth, access.principal);
router.get("/admin/session", access.admin, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ email: req.principal.email, fullName: req.principal.fullName, role: req.principal.adminRole, permissions: req.principal.permissions });
});
router.get("/users", access.admin, getAllUsers);
router.post("/registration/:id/owner-approve", access.owner, registration.ownerApproveRegistration);
router.patch("/users/:id/portal-access", access.owner, registration.ownerDecidePortalAccess);
router.get("/users/:id/trading-verification/evidence", access.owner, ownerTradingReview.getEvidence);
router.get("/trading-review-client", access.admin, ownerTradingReview.findClient);
router.post("/users/:id/trading-verification", access.admin, (req, res, next) => {
  if (!canApproveTrading(req.principal)) return res.status(403).json({ message: "Trading approval permission is required." });
  ownerEvidenceUpload(req, res, error => error
    ? res.status(400).json({ message: "Upload one identity file and one proof of address file. Each file can be up to 10 MB." })
    : next());
}, ownerTradingReview.approve);
router.get("/user/:email", access.emailOwner(), getUserByEmail);
router.put(
  "/profile-image/:email",
  access.emailOwner(),
  upload.single("profileImage"),
  uploadProfileImage,
);

router.put("/update-profile/:email", access.emailOwner(), updateUserProfile);

router.put(
  "/documents/:email",
  access.emailOwner(),
  (_req, res, next) => require("../services/veriff.service").isEnabled() ? next() :
    res.status(410).json({ message: "BDFX is not accepting identity document uploads on this page." }),
  upload.uploadKycDocuments([
    { name: "idProof1Image", maxCount: 1 },
    { name: "idProof2Image", maxCount: 1 },
  ]),
  updateDocuments,
);

router.put("/bank/:email", access.emailOwner(), updateBankDetails);
router.patch("/bank-approve/:email", access.admin, approveBankDetails);

router.put("/change-password/:email", access.emailOwner(), changePassword);
router.put("/:email/verify-kyc", access.admin, verifyKyc);
router.post("/manual-kyc/:email", (_req, res, next) => require("../services/veriff.service").isEnabled() ? next() :
  res.status(410).json({ message: "Review the documents uploaded to BDFX from the client record." }));
router.post("/manual-kyc/:email", access.owner, require("../controllers/manualKycController").review);
router.get("/unverified", access.admin, getUnverifiedUsers);
router.delete("/delete/:email", access.admin, deleteUser);
router.post("/reject/:email", access.admin, rejectUserKyc);
router.get("/userByRef/:referralCode", access.admin, userByReferralCode);

module.exports = router;
