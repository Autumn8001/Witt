// Synthetic screenshot/test data only. Never imported by the application.
import {ids,makeConversation} from './workspace-fixture.mjs';
export const focusTask={
 ...makeConversation(ids.one,'图片附件失败时的反馈','witt-personal','检查上传响应与错误提示的衔接'),
 workDir:'D:\\Coding\\witt-personal',accessMode:'workspace-write',busy:true,
 taskStatus:{state:'running',label:'正在检查上传错误分支'},
 messages:[
  {id:'11111111-1111-4111-8111-111111111111',role:'user',text:'检查图片附件上传失败时的反馈。先定位原因，不修改文件。',status:'completed',createdAt:new Date().toISOString()},
  {id:'22222222-2222-4222-8222-222222222222',role:'assistant',status:'running',createdAt:new Date().toISOString(),stream:[
   {id:'intro',kind:'message',phase:'commentary',status:'completed',text:'我会沿着“选择文件 → 上传 → 关联消息”的链路检查，先确认失败如何返回到界面，保持只读。'},
   {id:'read-bridge',kind:'command',status:'completed',label:'读取 web/browser-bridge.js',hasDetails:true,details:{cwd:'D:\\Coding\\witt-personal',output:'测试工具输出：上传入口使用 XMLHttpRequest。',exitCode:0}},
   {id:'search-upload',kind:'command',status:'completed',label:'检索文件上传与失败回调',hasDetails:true,details:{cwd:'D:\\Coding\\witt-personal',output:'测试工具输出：定位 onUploadProgress 与 onUploadFinished。',exitCode:0}},
   {id:'working',kind:'message',phase:'commentary',status:'running',text:'已找到上传入口。正在核对网络失败与服务端拒绝时的反馈路径。'},
  ]},
 ],
};
export const focusHistory=[focusTask,
 makeConversation(ids.two,'远程工作区的连接检查','witt-personal','检查设备与允许目录'),
 makeConversation(ids.three,'梳理 Runtime 配置','chloe-cli','核对模型配置'),
 makeConversation('00000000-0000-4000-8000-000000000004','修复移动端菜单遮挡','witt-personal','检查窄屏行为'),
];
