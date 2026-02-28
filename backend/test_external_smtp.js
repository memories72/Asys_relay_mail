const nodemailer = require('nodemailer');

async function testSmtp(port, secure) {
    console.log(`\n--- Testing Port: ${port}, Secure: ${secure} ---`);
    const transporter = nodemailer.createTransport({
        host: '110.45.130.130',
        port: port,
        secure: secure,
        auth: {
            user: 'mg.hwang',
            pass: '051081mh.'
        },
        tls: {
            rejectUnauthorized: false,
            ciphers: 'DEFAULT@SECLEVEL=0'
        },
        debug: true,
        logger: true
    });

    try {
        console.log('Verifying connection...');
        await transporter.verify();
        console.log('✓ Verification Success!');

        console.log('Sending test mail...');
        const info = await transporter.sendMail({
            from: 'mg.hwang@agilesys.co.kr',
            to: 'heemin72@gmail.com',
            subject: `SMTP External Test - Port ${port}`,
            text: `This is a test from the host script using port ${port}. Time: ${new Date().toISOString()}`
        });
        console.log('✓ Mail Sent! MessageId:', info.messageId);
    } catch (err) {
        console.error('✕ Failed:', err.message);
    }
}

async function run() {
    // Test Port 25
    await testSmtp(25, false);

    // Test Port 587
    await testSmtp(587, false);
}

run();
