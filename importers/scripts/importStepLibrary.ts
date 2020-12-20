import { S3 } from '@aws-sdk/client-s3'
import { createWriteStream } from 'fs'
import { get } from 'http'

const PUBLIC_BUCKET_NAME = 'tyndale-house-public'
const REGION = 'eu-west-1'

const main = async () => {
    const urls = await getSwordModuleDownloadUrls(PUBLIC_BUCKET_NAME)
    urls.forEach(url => downloadSwordFile(url))
}

const downloadSwordFile = (url: string) => {
    const pieces = url.split('/')
    const filename = pieces[pieces.length - 1]
    const path = `data/step-library/${filename}`
    const file = createWriteStream(path);
    return get(url, (response) => {
        response.pipe(file);
    })
}

const getSwordModuleDownloadUrls = async (bucketName: string) => {
    const s3 = new S3({ region: REGION });
    const S3_BASE_URL = `http://${bucketName}.s3-${REGION}.amazonaws.com`
    const { Contents } = await s3.listObjects({ Bucket: PUBLIC_BUCKET_NAME })
    if (!Contents) {
        throw new Error('Bucket has no contents')
    }
    return Contents
        .map(object => object.Key)
        .filter(key => (
            key?.includes('.zip')
        ))
        .map(key => `${S3_BASE_URL}/${key}`)
}

main().catch(error => console.log(error))