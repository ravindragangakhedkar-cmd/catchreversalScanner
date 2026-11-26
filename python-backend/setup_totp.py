"""One-time interactive Nubra TOTP setup.

Run locally in PowerShell:
    py -m pip install nubra-sdk
    py setup_totp.py

The generated TOTP secret is sensitive. Save it directly in Render's
NUBRA_TOTP_SECRET environment variable. Never commit it or send it in chat.
"""
from nubra_python_sdk.start_sdk import InitNubraSdk, NubraEnv


def main():
    print("Starting Nubra's official Python SDK login.")
    print("Enter your registered mobile number, SMS OTP and MPIN when prompted.")
    client = InitNubraSdk(NubraEnv.PROD)
    secret = client.totp_generate_secret()
    print("\nNubra TOTP secret (keep private):")
    print(secret)
    print("\nNow enable TOTP. Follow the SDK prompts and enter the authenticator code.")
    client.totp_enable()
    print("\nTOTP setup completed. Add PHONE_NO, MPIN and this TOTP secret to Render.")
    try:
        client.logout()
    except Exception:
        pass


if __name__ == "__main__":
    main()
