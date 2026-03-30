import { runEnterpriseRoute } from '../../../../../../utils/enterprise'

export default defineEventHandler(event => runEnterpriseRoute('deleteProjectWebhook', 'webhook.upgrade', event))
