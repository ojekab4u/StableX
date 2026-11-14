const PHONE_E164_REGEX = /^\+\d{7,15}$/;

// Maps stored account data onto the subject fields VOVE KYC/KYB cases accept,
// plus the split-name/date shape Bridge customer creation needs. Registration
// data therefore feeds verification without the user retyping everything.
export function buildComplianceSubject(account, extras = {}) {
  const fullName = String(account.fullName || "").trim();
  const nameParts = fullName.split(/\s+/);
  const subject = {
    fullName,
    country: String(account.country || "").trim().toUpperCase(),
    email: String(account.email || "").trim(),
    ...(account.dateOfBirth ? { dateOfBirth: account.dateOfBirth } : {}),
  };
  if (nameParts.length > 1) {
    subject.firstName = nameParts[0];
    subject.lastName = nameParts.slice(1).join(" ");
  }
  if (account.phone) subject.phone = account.phone;
  if (account.accountType === "BUSINESS") {
    subject.businessName = String(account.businessName || fullName).trim();
  }
  // Optional extras the account does not store (registrationNumber, city,
  // address). Only clean string values are accepted.
  for (const field of ["registrationNumber", "city", "address"]) {
    const value = extras[field];
    if (typeof value === "string" && value.trim()) subject[field] = value.trim().slice(0, 200);
  }
  return subject;
}

// What external providers can draw from stored registration data, so operator
// consoles (e.g. Bridge customer creation) can prefill without re-collecting PII.
export function buildProviderPrefill(account) {
  const fullName = String(account.fullName || "").trim();
  const nameParts = fullName.split(/\s+/);
  return {
    vove: {
      subjectType: account.accountType === "BUSINESS" ? "BUSINESS" : "INDIVIDUAL",
      subject: buildComplianceSubject(account),
    },
    bridge: {
      firstName: nameParts[0] || "",
      lastName: nameParts.length > 1 ? nameParts.slice(1).join(" ") : "",
      email: account.email,
      phone: account.phone && PHONE_E164_REGEX.test(account.phone.trim())
        ? account.phone.trim()
        : null,
      birthDate: account.dateOfBirth || null,
      note: "Bridge customer creation additionally requires ToS acceptance, a passport number and a passport image, collected at the operator endpoint.",
    },
  };
}
