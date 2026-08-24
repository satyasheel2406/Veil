import re

KIND_KEYWORDS: dict[str, tuple[str, ...]] = {
    "email": ("email", "e-mail"),
    "password": ("password", "passwd", "passcode"),
    "phone": ("phone", "mobile", "telephone", "tel"),
    "card": ("card", "credit", "debit", "cc"),
    "cvv": ("cvv", "cvc", "security code"),
    "person_name": ("name", "first name", "last name", "full name", "recipient"),
    "address": ("address", "street", "city", "zip", "postal"),
    "ssn": ("ssn", "social security"),
    "aadhaar": ("aadhaar", "aadhar"),
    "iban": ("iban",),
    "dob": ("birth", "dob"),
}

SUBMIT_RE = re.compile(
    r"\b(sign\s?in|log\s?in|login|sign\s?up|signup|register|create\s+account|submit|next|continue|search|pay|book|confirm|send|send\s+money|place\s+order|get\s+started|transfer)\b",
    re.I,
)

# Navigation patterns for multi-page flows
NAVIGATE_RE = re.compile(
    r"\b(transfer\s+money|fund\s+transfer|new\s+transfer|view\s+statement|back\s+to\s+dashboard|download\s+receipt)\b",
    re.I,
)
