const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({});

exports.handler = async (event) => {
    const processedBucket = process.env.PROCESSED_BUCKET_NAME;
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
    const targetBucketName = "dea-lead-owner";

    try {
        // 1. EXTRACT BUCKET AND KEY FROM NATIVE EVENTBRIDGE PAYLOAD
        const rawBucket = event.detail.bucket.name;
        const rawKey = decodeURIComponent(event.detail.object.key.replace(/\+/g, " "));

        console.log(`Processing file ${rawKey} from raw bucket ${rawBucket}`);

        // 2. EXTRACT LEAD_ID FROM FILENAME (crm_event_{lead_id}.json)
        const match = rawKey.match(/crm_event_(.+)\.json$/);
        if (!match) {
            console.error(`File name ${rawKey} does not match expected format crm_event_{lead_id}.json`);
            return { status: "Skipped", message: "Invalid file name format" };
        }
        const leadId = match[1];

        // 3. FETCH RAW LEAD DATA FROM S3
        const rawDataString = await fetchS3Object(rawBucket, rawKey);
        const rawData = sanitizePythonStringDump(rawDataString);

        // 4. CONSTRUCT PUBLIC URL & FETCH UPDATED DATA
        const publicUrl = `https://${targetBucketName}.s3.us-east-1.amazonaws.com/${leadId}.json`;
        console.log(`Fetching updated data from public URL: ${publicUrl}`);
        
        const httpResponse = await fetch(publicUrl);
        if (!httpResponse.ok) {
            throw new Error(`Failed to fetch public lead data from ${publicUrl}:\n ${httpResponse.statusText} (Status: ${httpResponse.status})`);
        }
        const updatedData = await httpResponse.json();

        // 5. MERGE RAW JSON WITH UPDATED JSON
        const mergedData = {
            ...rawData,
            updated_fields: { ...updatedData },
            data: {
                ...rawData.data,
                lead_email: updatedData.lead_email,
                lead_owner: updatedData.lead_owner,
                funnel: updatedData.funnel
            }
        };

        // 6. SAVE MERGED JSON TO PROCESSED S3 BUCKET
        await s3.send(new PutObjectCommand({
            Bucket: processedBucket,
            Key: rawKey,
            Body: JSON.stringify(mergedData, null, 2),
            ContentType: "application/json"
        }));
        console.log(`Successfully saved merged lead data to ${processedBucket}/${rawKey}`);

        // 7. SEND NOTIFICATION TO SLACK
        if (slackWebhookUrl) {
            await sendSlackNotification(slackWebhookUrl, mergedData.data);
            console.log("Slack notification sent successfully.");
        } else {
            console.warn("Slack Webhook URL missing from environment variables. Skipping alert.");
        }

    } catch (error) {
        console.error("Error processing record: ", error);
        throw error; // Forces the Step Functions step to fail cleanly for tracking
    }

    return { status: "Success" };
};

// Helper function to pull and stringify objects from S3
async function fetchS3Object(bucket, key) {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await response.Body.transformToString();
}

// Helper function to turn the malformed string dump into a valid JavaScript Object
function sanitizePythonStringDump(rawText) {
    try {
        // Step A: Extract just the dictionary string between 'event: ' and ' subscription_id:'
        const objectExtraction = rawText.match(/event:\s*(\{[\s\S]*\})\s*subscription_id:/);
        if (!objectExtraction) {
            throw new Error("Could not parse 'event' data boundaries from source text file.");
        }
        let cleanString = objectExtraction[1];

        // Step B: Match bare tokens OR single-quoted strings to process them cleanly
        cleanString = cleanString.replace(/(\bTrue\b|\bFalse\b|\bNone\b)|('([^'\\]|\\.)*')/g, (match, token) => {
            // If it's a bare Python token outside of quotes, map it to valid JSON equivalents
            if (token) {
                if (token === 'None') return 'null';
                if (token === 'True') return 'true';
                if (token === 'False') return 'false';
            }
            
            // If it's a single-quoted string literal, protect its contents, 
            // escape inner double quotes, and safely wrap the outside in double quotes.
            let innerContent = match.slice(1, -1);
            innerContent = innerContent.replace(/"/g, '\\"');
            return `"${innerContent}"`;
        });

        return JSON.parse(cleanString);
    } catch (e) {
        throw new Error(`Sanitization Routine Failed: ${e.message}. Raw text snippet: ${rawText.substring(0, 60)}`);
    }
}

// Helper function to format and send Slack alerts
async function sendSlackNotification(webhookUrl, leadData) {
    const slackPayload = {
        blocks: [
            {
                type: "header",
                text: {
                    type: "plain_text",
                    text: "🚀 Updated Lead Information",
                    emoji: true
                }
            },
            {
                type: "section",
                fields: [
                    { type: "mrkdwn", text: `*Name:*\n${leadData.display_name || "N/A"}` },
                    { type: "mrkdwn", text: `*Email:*\n${leadData.lead_email || "N/A"}` },
                    { type: "mrkdwn", text: `*Owner:*\n${leadData.lead_owner || "N/A"}` },
                    { type: "mrkdwn", text: `*Funnel Pipeline:*\n${leadData.funnel || "N/A"}` },
                    { type: "mrkdwn", text: `*Status:*\n\`${leadData.status_label || "N/A"}\`` },
                    { type: "mrkdwn", text: `*Lead ID:*\n\`${leadData.id || "N/A"}\`` }
                ]
            },
            {
                type: "context",
                elements: [
                    { type: "mrkdwn", text: `📍 View profile: <${leadData.url || "https://close.com"}|Open in Close CRM>` }
                ]
            }
        ]
    };

    const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackPayload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Slack API error: ${response.status} - ${errText}`);
    }
}
