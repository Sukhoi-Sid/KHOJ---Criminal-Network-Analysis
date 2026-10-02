import neo4j, { type Driver } from 'neo4j-driver';
import { env } from './env';

// The only application owner of the Neo4j driver/pool; sessions are short-lived.
let driver: Driver | undefined;
export function graphDriver() {
  return driver ??= neo4j.driver(env.NEO4J_URI,neo4j.auth.basic(env.NEO4J_USERNAME,env.NEO4J_PASSWORD),{
    connectionTimeout:5000,connectionAcquisitionTimeout:5000,maxTransactionRetryTime:3000,maxConnectionPoolSize:10,
    disableLosslessIntegers:true,
  });
}
export async function closeGraphDriver() { if(driver) {await driver.close();driver=undefined;} }
export async function checkGraphConnection() {try {await graphDriver().verifyConnectivity({database:env.NEO4J_DATABASE});return true;} catch {return false;} }
export const graphNamespace=()=>env.NODE_ENV==='test'?'test':'application';
