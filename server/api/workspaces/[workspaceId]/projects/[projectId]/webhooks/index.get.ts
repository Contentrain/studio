import { runEnterpriseRoute } from '../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('listProjectWebhooks', 'webhook.upgrade', event))
