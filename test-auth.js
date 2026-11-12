const assert = require("assert");
const auth = require("./auth-utils");

assert.equal(auth.validateEmail("User@example.com").valid, true);
assert.equal(auth.validateEmail("not-an-email").valid, false);
assert.equal(auth.validateUsername("Karthi_01").valid, true);
assert.equal(auth.validateUsername("1bad").valid, false);
assert.equal(auth.validatePassword("Strong#123", { username: "karthi", email: "karthi@example.com" }).valid, true);
assert.equal(auth.validatePassword("password", {}).valid, false);

const otp = auth.generateOtp();
assert.match(otp, /^\d{6}$/);
const salt = auth.generateOtpSalt();
const hash = auth.hashOtp(otp, salt, "test-secret");
assert.equal(auth.verifyOtp(otp, salt, hash, "test-secret"), true);
assert.equal(auth.verifyOtp("000000", salt, hash, "test-secret"), otp === "000000");

console.log("Authentication utility tests passed.");
