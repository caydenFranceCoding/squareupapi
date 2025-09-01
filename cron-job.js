const { Client, Environment } = require('square');
require('dotenv').config();

const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production'
    ? Environment.Production
    : Environment.Sandbox
});

class CronJobs {
  static async keepAlive() {
    try {
      const serverUrl = process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL;
      
      if (serverUrl) {
        const response = await fetch(`${serverUrl}/health`);
        const data = await response.json();
        return { success: true, status: data.status };
      }
      
      return { success: true, message: 'Keep-alive completed' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  static async syncWithSquare() {
    try {
      const locationsApi = squareClient.locationsApi;
      const response = await locationsApi.listLocations();
      
      if (response.result && response.result.locations) {
        return { 
          success: true, 
          locationCount: response.result.locations.length 
        };
      }
      
      return { success: false, error: 'No locations found' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  static async healthCheck() {
    try {
      const checks = await Promise.allSettled([
        this.keepAlive(),
        this.syncWithSquare()
      ]);
      
      return {
        success: true,
        results: {
          keepAlive: checks[0].status === 'fulfilled' ? checks[0].value : { success: false },
          squareSync: checks[1].status === 'fulfilled' ? checks[1].value : { success: false }
        }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

async function runCronJob() {
  const jobType = process.argv[2] || 'healthCheck';
  
  let result;
  switch (jobType) {
    case 'keepAlive':
      result = await CronJobs.keepAlive();
      break;
    case 'syncSquare':
      result = await CronJobs.syncWithSquare();
      break;
    case 'healthCheck':
    default:
      result = await CronJobs.healthCheck();
      break;
  }
  
  process.exit(result.success ? 0 : 1);
}

if (require.main === module) {
  runCronJob().catch(() => process.exit(1));
}

module.exports = { CronJobs };
