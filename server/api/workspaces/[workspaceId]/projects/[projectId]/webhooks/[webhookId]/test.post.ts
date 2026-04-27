import { runEnterpriseRoute } from '../../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('testProjectWebhook', 'webhook.upgrade', event, 'api.webhooks_outbound'))
