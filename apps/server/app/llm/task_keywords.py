import re

KIND_KEYWORDS: dict[str, tuple[str, ...]] = {
    "email": ("email", "e-mail"),
    "password": ("password", "passwd", "passcode"),
    "phone": ("phone", "mobile", "telephone", "tel"),
    "card": ("card", "credit", "debit", "cc"),
    "cvv": ("cvv", "cvc", "security code"),
    "person_name": ("name", "first name", "last name", "full name"),
    "address": ("address", "street", "city", "zip", "postal"),
    "ssn": ("ssn", "social security"),
    "aadhaar": ("aadhaar", "aadhar"),
    "iban": ("iban",),
    "dob": ("birth", "dob"),
}

SUBMIT_RE = re.compile(
    r"\b(sign\s?in|log\s?in|login|submit|next|continue|search|pay|book|confirm|send|place\s+order|get\s+started)\b",
    re.I,
)
