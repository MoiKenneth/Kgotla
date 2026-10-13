# Going live

This takes Kgotla from demo cells (example people and money) to a **live** cell where real people sign up with their own phone numbers, pay real money with PayPal, cards or mobile money, and book lodges, game reserves, parks and drivers.

Everything below is built and tested. What is left are accounts only you can open (Azure, PayPal, DPO Pay, Twilio) and settings to switch on.

## What runs in a live cell

| | Live cell |
|---|---|
| Sign-up | Open: name, date of birth, ID number and mobile number, a real SMS code, a selfie and a PIN. The account starts at **assurance level 2**: wallet, payments, bookings and partner services work; government services (licence renewal, tax clearance, birth certificates) stay locked until a registry link verifies the person (level 3). |
| SMS | Twilio: sign-up codes, receipts, queue calls and booking confirmations go to real phones. |
| Money in | **PayPal** (PayPal balance or card; charged in USD at your set rate) and **DPO Pay** (Visa, Mastercard and mobile money in local currency). People top up the wallet, or pay a booking or bill straight from the review screen. Payments are confirmed with the provider before anything is credited, and a background check catches payments whose browser never came back. |
| Money out | Wallet payments to bills, partners (clinics, lodges, drivers) and parks are recorded as owed to them in the ledger. Paying those out to their bank accounts is a manual settlement for now (see "Still to do"). |
| Tourism | Lodges, hotels, camps and guesthouses; private game reserves; national parks; safaris and tours; drivers, driver-guides and airport transfers. Parks start **closed** until the parks agency enters its real fees in the officer console. Lodges, reserves and drivers join through the partner portal and publish their own rooms and trips. |
| Staff | The first admin is created automatically. The admin adds staff (case workers, counter and park-gate staff) in the officer console, Staff tab. |
| Demo data | None. No example people, money or partners. |

## Step by step

### 1. Azure (about 20 minutes, once)

Follow [DEPLOY.md](DEPLOY.md): create the subscription, run `infra/bootstrap.sh` in Cloud Shell, and add `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` as GitHub secrets. Run the workflow once in demo mode to check everything deploys.

### 2. PayPal

1. Sign in at <https://developer.paypal.com> with the **business** PayPal account that should receive the money.
2. **Apps & Credentials** → choose **Sandbox** first → **Create App**. Copy the client ID and secret.
3. In GitHub, add secrets `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, and the variable `PAYPAL_FX_RATE`: how many pula (or rand, kwacha…) make one US dollar, for example `13.6`. Kgotla rounds up, so the business is never short.
4. Test with PayPal's sandbox buyer accounts. When happy, create the **Live** app, replace the two secrets with the live ones, and set the variable `PAYPAL_ENV` to `live`.

PayPal settles in USD (it does not support BWP, ZAR, NAD or ZMW), and fees and currency conversion apply. Check that your business PayPal account can receive payments in your country, and how you withdraw the money (FNB Botswana, for example, advertises a PayPal withdrawal service).

### 3. DPO Pay (cards and mobile money in local currency)

1. Apply for a DPO Pay merchant account (DPO Group operates across Southern Africa). They give you a **company token** and a **service type** number.
2. Add the GitHub secret `DPO_COMPANY_TOKEN` and the variable `DPO_SERVICE_TYPE`.
3. Ask DPO which payment options (cards, Orange Money, MyZaka, M-Pesa, Airtel Money, EcoCash…) are enabled on your account for each country.

The integration uses DPO's API v6 (`createToken`, hosted payment page, `verifyToken`). Test it against your DPO test account before going live, and confirm the endpoint addresses DPO gives you (the defaults are in `.env.example`).

### 4. Twilio (SMS)

1. Create an account at <https://www.twilio.com>, upgrade it (trial accounts only text verified numbers), and buy a number or register an alphanumeric sender ID for each country you serve.
2. Add GitHub secrets `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, and the variable `TWILIO_FROM` (the number, like `+14155550123`, or the sender ID).

A local aggregator or an operator's bulk SMS service is usually cheaper at volume. Adding one means writing one small adapter next to `TwilioSms` in `apps/api/src/lib/notify.ts`.

### 5. Switch to live

In GitHub, **Settings → Secrets and variables → Actions → Variables**, set `KGOTLA_MODE` to `live`, then run **Deploy to Azure**.

A live cell needs its own database, so do not switch an existing demo cell to live. Either deploy live to a new country code, or delete the demo cell's resource group first (`az group delete --name kgotla-bw`, then purge its Key Vault) and redeploy.

### 6. First sign-in and setup

1. Get the admin password: `az keyvault secret show --vault-name <vault> --name admin-bootstrap-password --query value -o tsv`.
2. Open `https://<cell>/officer.html` and sign in as `admin`.
3. **Staff**: add park-gate staff (agency `DWNP` in Botswana, role counter), case workers and counter staff.
4. **Parks**: enter each park's official fees, then tick **Open** to make it bookable.
5. **Partners**: lodges, reserves, drivers, clinics and banks apply at `https://<cell>/partners.html`. Review and approve them here.
6. **Directory**: add every official portal citizens should find (BURS, banks, hospitals…).
7. Optional: add a custom domain such as `app.kgotla.co.bw` to the Container App, with a managed certificate.

### 7. Check it end to end with real money

Sign up with your own phone. Top up P 20 with PayPal and P 20 with DPO. Book something small, cancel it within the free window, and check the refund. Then confirm in PayPal and DPO that the amounts match the Kgotla ledger.

## Still to do before scaling up

- **Licence to hold money.** A wallet that holds people's money needs an e-money or payment-service licence (Bank of Botswana in Botswana) or a sponsor bank. Until then, a safer launch is pay-as-you-go: people pay each booking directly with PayPal or DPO (already supported) rather than keeping a balance.
- **Settlement to partners.** Money owed to lodges, drivers, clinics and parks agencies sits in ledger accounts (`payable:partner:…`, `payable:agency:…`). Pay it out weekly by bank transfer from a report, until an automated payout is built.
- **Refunds to cards and PayPal.** Cancellations refund to the Kgotla wallet. Refunds back to the original card or PayPal account need the providers' refund APIs (both offer one).
- **Identity verification (level 3).** Needs the national registry link and a certified liveness and face-match vendor. Until then government services stay locked, which is the safe default.
- **Mobile money directly.** Orange Money, MyZaka, MTN MoMo, Airtel Money and EcoCash work today through DPO Pay. Direct operator integrations, which are cheaper, need agreements with each operator.
- **Data protection.** Register with the data protection authority, and publish a privacy notice and terms of use before inviting the public.
