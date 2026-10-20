-- ISO 8583 merchant acceptance profile.
-- Merchant-supplied onboarding/KYC stays in merchants.merchants.kyc_data.
-- Acquirer-assigned identifiers live here and are only set by the internal platform.
CREATE TABLE merchants.iso8583_profiles (
  merchant_id               text PRIMARY KEY REFERENCES merchants.merchants(id) ON DELETE CASCADE,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','provisioned','suspended')),
  mcc                       text CHECK (mcc IS NULL OR mcc ~ '^[0-9]{4}$'),
  acquirer_merchant_id      text CHECK (acquirer_merchant_id IS NULL OR char_length(acquirer_merchant_id) BETWEEN 1 AND 15),
  terminal_id               text CHECK (terminal_id IS NULL OR char_length(terminal_id) BETWEEN 1 AND 8),
  acquiring_institution_id  text CHECK (acquiring_institution_id IS NULL OR acquiring_institution_id ~ '^[0-9]{1,11}$'),
  currency_numeric          text NOT NULL DEFAULT '928' CHECK (currency_numeric ~ '^[0-9]{3}$'),
  pos_entry_mode            text NOT NULL DEFAULT '090' CHECK (pos_entry_mode ~ '^[0-9]{3}$'),
  pos_condition_code        text NOT NULL DEFAULT '59' CHECK (pos_condition_code ~ '^[0-9]{2}$'),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE merchants.iso8583_profiles IS
  'Acquirer-provisioned ISO 8583 merchant identifiers. Never stores PAN, CVV, PIN, track data or cardholder authentication data.';
