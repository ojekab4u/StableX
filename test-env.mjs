import "dotenv/config";
console.log("VOVE_ID_API_KEY:", process.env.VOVE_ID_API_KEY ? "SET: " + process.env.VOVE_ID_API_KEY : "EMPTY");
console.log("VOVE_ID_PUBLIC_KEY:", process.env.VOVE_ID_PUBLIC_KEY ? "SET: " + process.env.VOVE_ID_PUBLIC_KEY : "EMPTY");
console.log("VOVE_ID_WEBHOOK_SECRET:", process.env.VOVE_ID_WEBHOOK_SECRET ? "SET: " + process.env.VOVE_ID_WEBHOOK_SECRET : "EMPTY");