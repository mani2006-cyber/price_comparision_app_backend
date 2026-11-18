
require("dotenv").config();
const nodemailer = require("nodemailer");

async function testSMTP() {
    try {
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT),
            secure: process.env.SMTP_SECURE === "true",
            auth: {
                user: process.env.SMTP_USERNAME,
                pass: process.env.SMTP_PASSWORD
            },
            connectionTimeout: 5000
        });

        // Verify SMTP connection and authentication
        await transporter.verify();

        console.log("SMTP connection successful!");

        // Send a test email
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: process.env.SMTP_USERNAME,
            subject: "SMTP Test Email",
            text: "Congratulations! Your SMTP configuration is working."
        });

        console.log("Email sent successfully!");
        console.log("Message ID:", info.messageId);

    } catch (error) {
        console.error("SMTP test failed:", error.message);
    }
}

testSMTP();
