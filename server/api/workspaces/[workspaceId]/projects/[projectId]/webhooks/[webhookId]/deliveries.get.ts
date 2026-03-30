import { runEnterpriseRoute } from '../../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('listWebhookDeliveries', 'webhook.upgrade', event))
