import nodemailer from 'nodemailer';

export async function sendInviteEmail(toEmail, inviteUrl, orgName) {
  const emailHost = process.env.EMAIL_HOST;
  const emailPort = process.env.EMAIL_PORT;
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;
  const emailFrom = process.env.EMAIL_FROM;

  // Check if email is configured
  if (!emailHost || !emailPort || !emailUser || !emailPass || !emailFrom) {
    console.warn('Email service not configured. Skipping email send.');
    return { sent: false, reason: 'Email not configured' };
  }

  try {
    // Create transporter
    const transporter = nodemailer.createTransport({
      host: emailHost,
      port: parseInt(emailPort, 10),
      secure: parseInt(emailPort, 10) === 465, // true for 465, false for other ports
      auth: {
        user: emailUser,
        pass: emailPass,
      },
    });

    // Build HTML email
    const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto;">
          <h2>You're invited to assess ${orgName}</h2>
          <p>Hi there,</p>
          <p>You have been invited to participate in a Provident Assessment for <strong>${orgName}</strong>. This assessment helps organizations evaluate their financial health and preparedness.</p>
          <p>Click the button below to accept the invitation and get started:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${inviteUrl}" style="display: inline-block; padding: 12px 30px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Accept Invitation</a>
          </div>
          <p>Or copy and paste this link: <a href="${inviteUrl}">${inviteUrl}</a></p>
          <p>If you have any questions, please reach out to the organization administrator.</p>
          <p>Best regards,<br>The Provident Assessment Platform</p>
        </div>
      </body>
    </html>
    `;

    // Send email
    const info = await transporter.sendMail({
      from: emailFrom,
      to: toEmail,
      subject: `Invitation to Provident Assessment - ${orgName}`,
      html: htmlContent,
    });

    console.log('Email sent successfully:', info.messageId);
    return { sent: true };
  } catch (error) {
    console.error('Error sending email:', error.message);
    return { sent: false, reason: error.message };
  }
}

export async function sendResetEmail(toEmail, resetUrl, userName) {
  const emailHost = process.env.EMAIL_HOST;
  const emailPort = process.env.EMAIL_PORT;
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;
  const emailFrom = process.env.EMAIL_FROM;

  if (!emailHost || !emailPort || !emailUser || !emailPass || !emailFrom) {
    console.warn('Email service not configured. Skipping reset email.');
    return { sent: false, reason: 'Email not configured' };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: emailHost,
      port: parseInt(emailPort, 10),
      secure: parseInt(emailPort, 10) === 465,
      auth: { user: emailUser, pass: emailPass },
    });

    const htmlContent = `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="max-width: 600px; margin: 0 auto;">
          <h2>Password Reset Request</h2>
          <p>Hi ${userName || 'there'},</p>
          <p>We received a request to reset your password for the Provident Assessment Platform.</p>
          <p>Click the button below to set a new password:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="display: inline-block; padding: 12px 30px; background-color: #0c2e3e; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset Password</a>
          </div>
          <p>Or copy and paste this link: <a href="${resetUrl}">${resetUrl}</a></p>
          <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
          <p>Best regards,<br>The Provident Assessment Platform</p>
        </div>
      </body>
    </html>
    `;

    const info = await transporter.sendMail({
      from: emailFrom,
      to: toEmail,
      subject: 'Password Reset — Provident Assessment Platform',
      html: htmlContent,
    });

    console.log('Reset email sent:', info.messageId);
    return { sent: true };
  } catch (error) {
    console.error('Error sending reset email:', error.message);
    return { sent: false, reason: error.message };
  }
}
